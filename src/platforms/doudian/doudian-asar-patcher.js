const fs = require('fs');
const path = require('path');
const os = require('os');
const asar = require('asar');
const { getDoudianConfig } = require('../../shared/config');
const { println } = require('../../shared/logger');
const { resolveInstallPaths } = require('./doudian-asar-analyzer');
const {
  PATCH_MARKER,
  PATCH_TARGET_FILES,
  PATCH_OPTIONAL_FILES,
  PATCH_TARGET_FILE,
  WORKSPACE_URL_PATTERN,
  PRELOAD_TEST_FLAG,
  RECOMMENDED_TEST_DIR,
  TEST_INSTALL_DIR,
  ORIGINAL_INSTALL_DIR,
} = require('./doudian-asar-patch-constants');
const { assertDoudianNotRunning, assertSafeInstallPath } = require('./doudian-asar-patch-guards');
const { buildMinimalPatchSnippet } = require('./doudian-asar-patch-snippet');
const { createTimestampedAsarBackup, writePatchManifest } = require('./doudian-patch-manifest');
const { buildRustWorkerPatchSnippet } = require('./injected/doudian-rust-worker-snippet');
const {
  BACKUP_ASAR_NAME,
  BACKUP_MD5_NAME,
  PATCH_META_NAME,
  PATCH_BACKUP_DIR_NAME,
  normalizeAsarInnerPath,
  verifyAsarPatch,
  verifyAsarFile,
} = require('./doudian-asar-patch-verify');

function getPatchMetaPath(resourcesDir) {
  return path.join(resourcesDir, PATCH_META_NAME);
}

function readPatchMeta(resourcesDir) {
  const metaPath = getPatchMetaPath(resourcesDir);
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

function writePatchMeta(resourcesDir, meta) {
  fs.writeFileSync(getPatchMetaPath(resourcesDir), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

function isFilePatched(content) {
  return String(content || '').includes(PATCH_MARKER);
}

function backupFile(src, backupPath) {
  if (!fs.existsSync(src)) return { ok: false, reason: 'missing' };
  if (fs.existsSync(backupPath)) return { ok: true, already: true, backupPath };
  fs.copyFileSync(src, backupPath);
  return { ok: true, backupPath };
}

async function extractAllAsar(asarPath, destDir) {
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.mkdirSync(destDir, { recursive: true });
  asar.extractAll(asarPath, destDir);
}

function getPatchStatus(installDir) {
  const verify = verifyAsarPatch(installDir);
  const paths = resolveInstallPaths(installDir);
  return {
    installDir: paths.root,
    patched: verify.ok,
    patchTargets: PATCH_TARGET_FILES,
    backupAsarExists: verify.backupAsarExists,
    backupMd5Exists: verify.backupMd5Exists,
    verify,
    meta: readPatchMeta(paths.resourcesDir),
  };
}

async function applyAsarPatch(installDir, options = {}) {
  const cfg = getDoudianConfig();
  if (!cfg.enableAsarPatch && !options.force) {
    println('patch 默认未启用，仅输出建议（设置 doudian.enableAsarPatch=true 或传入 --force）');
    return { ok: false, reason: 'patch_disabled', needConfig: 'doudian.enableAsarPatch=true' };
  }

  const processGuard = assertDoudianNotRunning();
  if (!processGuard.ok) {
    return processGuard;
  }

  const pathGuard = assertSafeInstallPath(installDir, {
    forceOriginal: options.forceOriginal,
  });
  if (!pathGuard.ok) {
    return pathGuard;
  }

  const paths = resolveInstallPaths(installDir);
  if (!fs.existsSync(paths.asarPath)) {
    return { ok: false, reason: 'app_asar_missing', path: paths.asarPath };
  }

  const bridgePort = Number(options.bridgePort || cfg.bridgePort || 19527);
  const existing = verifyAsarPatch(installDir, { bridgePort });
  if (existing.ok && !options.force) {
    println('asar 已 patch 且校验通过，跳过重复操作');
    return { ok: true, already: true, verify: existing, status: getPatchStatus(installDir) };
  }

  const backupAsar = path.join(paths.resourcesDir, BACKUP_ASAR_NAME);
  const backupMd5 = path.join(paths.resourcesDir, BACKUP_MD5_NAME);
  const md5Path = path.join(paths.root, 'md5.json');
  const patchBackupDir = path.join(paths.resourcesDir, PATCH_BACKUP_DIR_NAME);

  println('开始 asar patch（将先备份 app.asar）');
  println(`patch 目标（app.asar 内部）：${PATCH_TARGET_FILES.map((f) => f.replace(/\\/g, '/')).join(', ')}`);

  const timestampedBackup = createTimestampedAsarBackup(paths.asarPath);
  if (timestampedBackup.ok) {
    println(`已创建时间戳备份：${timestampedBackup.backupPath}`);
  }

  backupFile(paths.asarPath, backupAsar);
  if (fs.existsSync(md5Path)) backupFile(md5Path, backupMd5);
  if (!fs.existsSync(patchBackupDir)) fs.mkdirSync(patchBackupDir, { recursive: true });

  const preloadPatchSnippet = buildMinimalPatchSnippet(bridgePort);
  const rustWorkerPatchSnippet = buildRustWorkerPatchSnippet(bridgePort);
  const patchedInnerFiles = [];
  const originalBackups = {};

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doudian-asar-patch-'));
  const tempExtract = path.join(tempRoot, 'extract');
  const tempOutAsar = path.join(tempRoot, 'app.patched.asar');

  try {
    await extractAllAsar(paths.asarPath, tempExtract);

    for (const targetRel of PATCH_TARGET_FILES) {
      const inner = normalizeAsarInnerPath(targetRel);
      const targetDisk = path.join(tempExtract, inner.replace(/\\/g, path.sep));
      if (!fs.existsSync(targetDisk)) {
        if (PATCH_OPTIONAL_FILES.has(targetRel)) {
          println(`可选 patch 目标不存在，跳过：app.asar/${inner.replace(/\\/g, '/')}`);
          continue;
        }
        return { ok: false, reason: 'patch_target_missing', target: inner, note: '目标文件不在 app.asar 内' };
      }

      const patchSnippet = targetRel.includes('rust_im_worker')
        ? rustWorkerPatchSnippet
        : preloadPatchSnippet;
      const originalContent = fs.readFileSync(targetDisk, 'utf8');
      const backupName = inner.replace(/\\/g, '__') + '.orig';
      const backupDiskPath = path.join(patchBackupDir, backupName);
      fs.writeFileSync(backupDiskPath, originalContent, 'utf8');
      originalBackups[inner] = backupDiskPath;

      if (isFilePatched(originalContent) && !options.force) {
        println(`文件已含注入标记，跳过重复写入：app.asar/${inner.replace(/\\/g, '/')}`);
      } else {
        fs.writeFileSync(targetDisk, `${originalContent}\n${patchSnippet}`, 'utf8');
        println(`已写入 patch：app.asar/${inner.replace(/\\/g, '/')}`);
      }
      patchedInnerFiles.push(inner);
    }

    await asar.createPackage(tempExtract, tempOutAsar);

    const tempVerify = verifyAsarFile(tempOutAsar, { bridgePort });
    if (!tempVerify.ok) {
      println('临时 app.asar 校验失败，未替换正式文件');
      return {
        ok: false,
        reason: 'temp_asar_verify_failed',
        verify: tempVerify,
        message: 'createPackage 产物校验未通过',
      };
    }

    fs.copyFileSync(tempOutAsar, paths.asarPath);
    try {
      asar.uncache(paths.asarPath);
    } catch {
      // ignore
    }

    const verify = verifyAsarPatch(installDir, { bridgePort });
    if (!verify.ok) {
      println('注入标记校验失败，正在从 backup 回滚 app.asar');
      fs.copyFileSync(backupAsar, paths.asarPath);
      return {
        ok: false,
        reason: 'post_patch_verify_failed',
        verify,
        message: 'patch 后校验未通过，已自动回滚 app.asar',
      };
    }

    println('注入标记校验通过');
    for (const f of verify.patchedFiles) {
      println(`  ✓ ${f.displayPath} marker=${f.hasPatchMarker} wsUrl=${f.hasWsUrl}`);
    }

    const meta = {
      patchedAt: Date.now(),
      patchMarker: PATCH_MARKER,
      preloadTestFlag: PRELOAD_TEST_FLAG,
      patchMode: 'minimal_diagnostic',
      targetFiles: patchedInnerFiles,
      bridgePort,
      wsUrl: verify.expectedWsUrl,
      backupAsar,
      originalBackups,
      recommendedTestDir: RECOMMENDED_TEST_DIR,
    };
    writePatchMeta(paths.resourcesDir, meta);

    writePatchManifest({
      installDir,
      patchResult: { meta, verify },
      verifyResult: verify,
      backupPath: timestampedBackup.ok ? timestampedBackup.backupPath : backupAsar,
    });

    println('asar patch 完成，请从测试目录启动抖店客户端使注入生效');
    return {
      ok: true,
      meta,
      verify,
      patchedInnerFiles,
      status: getPatchStatus(installDir),
      timestampedBackupPath: timestampedBackup.ok ? timestampedBackup.backupPath : '',
    };
  } catch (err) {
    if (fs.existsSync(backupAsar)) {
      try {
        fs.copyFileSync(backupAsar, paths.asarPath);
        println('patch 异常，已从 backup 回滚 app.asar');
      } catch {
        // ignore
      }
    }
    return { ok: false, reason: 'patch_exception', error: String(err.message || err) };
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function rollbackAsarPatch(installDir, options = {}) {
  const processGuard = assertDoudianNotRunning();
  if (!processGuard.ok) {
    return processGuard;
  }

  const paths = resolveInstallPaths(installDir);
  const backupAsar = path.join(paths.resourcesDir, BACKUP_ASAR_NAME);
  const meta = readPatchMeta(paths.resourcesDir);

  if (!fs.existsSync(backupAsar)) {
    return { ok: false, reason: 'backup_missing', message: '未找到 app.asar.backup，无法回滚' };
  }

  fs.copyFileSync(backupAsar, paths.asarPath);

  const backupMd5 = path.join(paths.resourcesDir, BACKUP_MD5_NAME);
  const md5Path = path.join(paths.root, 'md5.json');
  if (fs.existsSync(backupMd5) && fs.existsSync(path.dirname(md5Path))) {
    fs.copyFileSync(backupMd5, md5Path);
  }

  if (fs.existsSync(getPatchMetaPath(paths.resourcesDir))) {
    writePatchMeta(paths.resourcesDir, {
      ...(meta || {}),
      rolledBackAt: Date.now(),
      patchedAt: null,
    });
  }

  const verify = verifyAsarPatch(installDir);
  println('asar patch 已回滚，请重启抖店客户端');
  return { ok: true, rolledBackAt: Date.now(), verify };
}

module.exports = {
  PATCH_MARKER,
  PATCH_TARGET_FILE,
  PATCH_TARGET_FILES,
  PRELOAD_TEST_FLAG,
  WORKSPACE_URL_PATTERN,
  buildMinimalPatchSnippet,
  getPatchStatus,
  applyAsarPatch,
  rollbackAsarPatch,
  verifyAsarPatch,
};
