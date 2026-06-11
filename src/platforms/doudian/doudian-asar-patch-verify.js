const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const asar = require('asar');
const { resolveInstallPaths, listAsarFiles, extractAsarFile } = require('./doudian-asar-analyzer');
const {
  PATCH_MARKER,
  PRELOAD_TEST_FLAG,
  BRIDGE_PATCH_FLAG,
  PATCH_TARGET_FILES,
  PATCH_OPTIONAL_FILES,
} = require('./doudian-asar-patch-constants');
const { expectedWsUrl } = require('./doudian-asar-patch-snippet');
const { getDoudianConfig } = require('../../shared/config');

const BACKUP_ASAR_NAME = 'app.asar.backup';
const BACKUP_MD5_NAME = 'md5.json.backup';
const PATCH_META_NAME = 'doudian-patch-meta.json';
const PATCH_BACKUP_DIR_NAME = 'doudian-patch-backups';

function normalizeAsarInnerPath(filePath) {
  return String(filePath || '').replace(/^\\/, '').replace(/\//g, '\\');
}

function readFileFromAsar(asarPath, innerPath) {
  const inner = normalizeAsarInnerPath(innerPath);
  return extractAsarFile(asarPath, inner).toString('utf8');
}

function fileExistsInAsar(asarPath, innerPath) {
  const inner = normalizeAsarInnerPath(innerPath);
  const files = listAsarFiles(asarPath).map(normalizeAsarInnerPath);
  return files.includes(inner);
}

function inspectPatchedFileContent(content, bridgePort) {
  const wsUrl = expectedWsUrl(bridgePort);
  return {
    hasPatchMarker: content.includes(PATCH_MARKER),
    hasPreloadTestFlag: content.includes(PRELOAD_TEST_FLAG),
    hasBridgePatchFlag: content.includes(BRIDGE_PATCH_FLAG),
    hasWsUrl: content.includes(wsUrl),
    wsUrl,
  };
}

function inspectMd5Risk(installRoot) {
  const md5Path = path.join(installRoot, 'md5.json');
  if (!fs.existsSync(md5Path)) {
    return { md5FileExists: false, mayValidateAppAsar: false, note: '未找到 md5.json' };
  }
  try {
    const md5 = JSON.parse(fs.readFileSync(md5Path, 'utf8'));
    const files = md5.files || {};
    const keys = Object.keys(files);
    const asarKeys = keys.filter((k) => /app\.asar/i.test(k));
    const critical = Array.isArray(md5.criticalFiles) ? md5.criticalFiles : [];
    const criticalHits = critical.filter((k) => /app\.asar/i.test(k));
    return {
      md5FileExists: true,
      mayValidateAppAsar: asarKeys.length > 0 || criticalHits.length > 0,
      asarKeysInMd5: asarKeys,
      criticalAsarEntries: criticalHits,
      note:
        asarKeys.length || criticalHits.length
          ? 'md5.json 中包含 app.asar 相关项，patch 后客户端可能校验失败'
          : 'md5.json 未直接列出 resources/app.asar，patch 后通常不会被 md5 拦截',
    };
  } catch (err) {
    return { md5FileExists: true, mayValidateAppAsar: null, note: `md5.json 解析失败：${err.message}` };
  }
}

function verifyAsarPatch(installDir, options = {}) {
  const paths = resolveInstallPaths(installDir);
  return verifyAsarFile(paths.asarPath, {
    ...options,
    installDir: paths.root,
    asarPath: paths.asarPath,
    backupAsarPath: path.join(paths.resourcesDir, BACKUP_ASAR_NAME),
    backupMd5Path: path.join(paths.resourcesDir, BACKUP_MD5_NAME),
    metaPath: path.join(paths.resourcesDir, PATCH_META_NAME),
    md5Root: paths.root,
  });
}

function verifyAsarFile(asarPath, options = {}) {
  try {
    asar.uncache(asarPath);
  } catch {
    // ignore
  }
  const cfg = getDoudianConfig();
  const bridgePort = Number(options.bridgePort || cfg.bridgePort || 19527);
  const wsUrl = expectedWsUrl(bridgePort);
  const installRoot = options.md5Root || path.dirname(path.dirname(asarPath));

  const result = {
    ok: false,
    installDir: options.installDir || installRoot,
    asarPath,
    appAsarExists: fs.existsSync(asarPath),
    backupAsarExists: options.backupAsarPath ? fs.existsSync(options.backupAsarPath) : false,
    backupMd5Exists: options.backupMd5Path ? fs.existsSync(options.backupMd5Path) : false,
    metaExists: options.metaPath ? fs.existsSync(options.metaPath) : false,
    bridgePort,
    expectedWsUrl: wsUrl,
    patchedFiles: [],
    allTargetsOk: false,
    markerCheckPassed: false,
    wsUrlCheckPassed: false,
    md5: inspectMd5Risk(installRoot),
  };

  if (!result.appAsarExists) {
    result.reason = 'app_asar_missing';
    return result;
  }

  for (const target of PATCH_TARGET_FILES) {
    const inner = normalizeAsarInnerPath(target);
    const entry = {
      innerPath: inner,
      displayPath: `app.asar → ${inner.replace(/\\/g, '/')}`,
      existsInAsar: false,
      hasPatchMarker: false,
      hasPreloadTestFlag: false,
      hasWsUrl: false,
      ok: false,
    };

    if (!fileExistsInAsar(asarPath, inner)) {
      if (PATCH_OPTIONAL_FILES.has(target)) {
        entry.skippedOptional = true;
        entry.ok = true;
        result.patchedFiles.push(entry);
        continue;
      }
      result.patchedFiles.push(entry);
      continue;
    }

    entry.existsInAsar = true;
    try {
      const content = readFileFromAsar(asarPath, inner);
      const checks = inspectPatchedFileContent(content, bridgePort);
      entry.hasPatchMarker = checks.hasPatchMarker;
      entry.hasPreloadTestFlag = checks.hasPreloadTestFlag;
      entry.hasWsUrl = checks.hasWsUrl;
      entry.ok = checks.hasPatchMarker && checks.hasWsUrl;
    } catch (err) {
      entry.error = String(err.message || err);
    }
    result.patchedFiles.push(entry);
  }

  const requiredFiles = result.patchedFiles.filter((f) => !f.skippedOptional);
  result.allTargetsOk = requiredFiles.every((f) => f.ok);
  result.markerCheckPassed = requiredFiles.every((f) => f.hasPatchMarker);
  result.wsUrlCheckPassed = requiredFiles.every((f) => f.hasWsUrl);
  result.ok =
    result.markerCheckPassed &&
    result.wsUrlCheckPassed &&
    requiredFiles.every((f) => f.existsInAsar);

  if (options.metaPath && fs.existsSync(options.metaPath)) {
    try {
      result.meta = JSON.parse(fs.readFileSync(options.metaPath, 'utf8'));
    } catch {
      result.meta = null;
    }
  }

  return result;
}

function computeFileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(buf).digest('hex');
}

module.exports = {
  BACKUP_ASAR_NAME,
  BACKUP_MD5_NAME,
  PATCH_META_NAME,
  PATCH_BACKUP_DIR_NAME,
  normalizeAsarInnerPath,
  readFileFromAsar,
  fileExistsInAsar,
  inspectPatchedFileContent,
  inspectMd5Risk,
  verifyAsarPatch,
  verifyAsarFile,
  computeFileHash,
};
