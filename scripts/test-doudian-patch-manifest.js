#!/usr/bin/env node
/**
 * patch manifest / backup / marker 专项测试
 * npm run doudian:test-patch-manifest
 */
const fs = require('fs');
const path = require('path');
const { TEST_INSTALL_DIR } = require('../src/platforms/doudian/doudian-asar-patch-constants');
const { verifyAsarPatch } = require('../src/platforms/doudian/doudian-asar-patch-verify');
const { ensureTestDirPatched } = require('../src/platforms/doudian/doudian-patch-ensure');
const { killDoudianProcesses } = require('./lib/auto-verify-utils');
const {
  readLatestPatchManifest,
  getManifestLatestPath,
} = require('../src/platforms/doudian/doudian-patch-manifest');
const { getDoudianConfig } = require('../src/shared/config');

async function main() {
  const cfg = getDoudianConfig();
  const bridgePort = Number(cfg.bridgePort || 19527);
  const result = {
    success: false,
    backupExists: false,
    patchMarkerOk: false,
    manifestExists: false,
    rollbackCommandPresent: false,
    verifyResult: false,
    manifestPath: getManifestLatestPath(),
    errors: [],
  };

  if (!fs.existsSync(TEST_INSTALL_DIR)) {
    result.errors.push(`测试目录不存在: ${TEST_INSTALL_DIR}`);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  killDoudianProcesses();
  await new Promise((r) => setTimeout(r, 1500));

  const ensured = await ensureTestDirPatched(TEST_INSTALL_DIR, { force: true, bridgePort });
  if (!ensured.ok) {
    result.errors.push(ensured.reason || ensured.message || 'ensureTestDirPatched failed');
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const verify = verifyAsarPatch(TEST_INSTALL_DIR, { bridgePort });
  result.patchMarkerOk = Boolean(verify.ok);
  result.verifyResult = Boolean(verify.ok);

  const manifest = readLatestPatchManifest() || ensured.manifest;
  result.manifestExists = Boolean(manifest && fs.existsSync(result.manifestPath));
  result.rollbackCommandPresent = Boolean(manifest?.rollbackCommand);
  result.backupExists = Boolean(
    (manifest?.backupPath && fs.existsSync(manifest.backupPath)) ||
      (manifest?.timestampedBackupPath && fs.existsSync(manifest.timestampedBackupPath)) ||
      (ensured.timestampedBackupPath && fs.existsSync(ensured.timestampedBackupPath))
  );

  result.success =
    result.backupExists &&
    result.patchMarkerOk &&
    result.manifestExists &&
    result.rollbackCommandPresent &&
    result.verifyResult;

  if (!result.backupExists) result.errors.push('backup 不存在');
  if (!result.patchMarkerOk) result.errors.push('patch marker 校验失败');
  if (!result.manifestExists) result.errors.push('manifest 不存在');
  if (!result.rollbackCommandPresent) result.errors.push('rollbackCommand 缺失');

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({ success: false, error: err.message || String(err) }, null, 2));
  process.exit(1);
});
