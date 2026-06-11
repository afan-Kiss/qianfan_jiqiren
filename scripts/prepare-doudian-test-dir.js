#!/usr/bin/env node
/**
 * 自动准备抖店测试目录（删除重建 + 完整复制）
 */
const fs = require('fs');
const path = require('path');
const {
  ORIGINAL_INSTALL_DIR,
  TEST_INSTALL_DIR,
  runCommand,
  getDiskFreeBytes,
  getDirSizeBytes,
  verifyKeyFiles,
  killDoudianProcesses,
} = require('./lib/auto-verify-utils');

async function prepareTestDir(options = {}) {
  const source = options.source || ORIGINAL_INSTALL_DIR;
  const dest = options.dest || TEST_INSTALL_DIR;
  const warnings = [];
  const errors = [];

  if (!fs.existsSync(source)) {
    return { ok: false, reason: 'source_missing', errors: [`原始目录不存在: ${source}`] };
  }

  if (!fs.existsSync(path.join(source, 'doudian.exe'))) {
    return { ok: false, reason: 'source_invalid', errors: [`原始目录缺少 doudian.exe: ${source}`] };
  }

  const sourceSize = getDirSizeBytes(source);
  const freeBytes = getDiskFreeBytes(path.parse(dest).root || 'D:');
  if (freeBytes > 0 && sourceSize > 0 && freeBytes < sourceSize * 1.2) {
    return {
      ok: false,
      reason: 'insufficient_disk_space',
      errors: [`磁盘空间不足: 需要约 ${Math.ceil(sourceSize / 1024 / 1024)}MB, 可用 ${Math.ceil(freeBytes / 1024 / 1024)}MB`],
    };
  }

  if (fs.existsSync(dest)) {
    const backupName = `${dest}_old_${Date.now()}`;
    try {
      fs.renameSync(dest, backupName);
      warnings.push(`旧测试目录已重命名为: ${backupName}`);
    } catch (err) {
      try {
        fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
        warnings.push(`旧测试目录已删除: ${dest}`);
      } catch (err2) {
        return {
          ok: false,
          reason: 'cleanup_failed',
          errors: [`无法清理旧测试目录: ${err2.message || err2}`],
        };
      }
    }
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const robocopy = runCommand(
    `robocopy "${source}" "${dest}" /MIR /R:2 /W:2 /NFL /NDL /NJH /NJS /NP`,
    { timeout: 600000 }
  );

  const robocopyOk = robocopy.exitCode !== undefined ? robocopy.exitCode < 8 : robocopy.ok;
  if (!robocopyOk) {
    return {
      ok: false,
      reason: 'copy_failed',
      errors: [`复制失败: ${robocopy.error || robocopy.output || 'robocopy error'}`],
      robocopy,
    };
  }

  const keyCheck = verifyKeyFiles(dest);
  if (!keyCheck.ok) {
    return {
      ok: false,
      reason: 'key_files_missing',
      errors: [`复制后缺少关键文件: ${keyCheck.missing.join(', ')}`],
      keyCheck,
    };
  }

  return {
    ok: true,
    source,
    dest,
    sourceSizeBytes: sourceSize,
    freeBytesBeforeCopy: freeBytes,
    keyCheck,
    warnings,
    robocopyExitCode: robocopy.exitCode,
  };
}

async function main() {
  killDoudianProcesses();
  const result = await prepareTestDir();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { prepareTestDir };
