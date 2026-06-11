#!/usr/bin/env node
/**
 * 等待真实买家消息验证
 * npm run doudian:wait-real-message
 * npm run doudian:wait-real-message -- --timeout-minutes 60
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { getDoudianConfig } = require('../src/shared/config');
const { ensureTestDirPatched } = require('../src/platforms/doudian/doudian-patch-ensure');
const { prepareTestDir } = require('./prepare-doudian-test-dir');
const {
  runWaitRealMessageSession,
  parseTimeoutMinutes,
  buildWaitTextReport,
} = require('./lib/doudian-wait-real-message-session');
const {
  ORIGINAL_INSTALL_DIR,
  TEST_INSTALL_DIR,
  killDoudianProcesses,
  writeReports,
  beginDoudianLiveRun,
} = require('./lib/auto-verify-utils');
const {
  validateShopReport,
  applyShopReportValidation,
} = require('../src/platforms/doudian/doudian-shop-report-validator');

async function ensureDependencies() {
  const nodeModules = path.join(process.cwd(), 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    execSync('npm install', { stdio: 'inherit', cwd: process.cwd(), timeout: 300000 });
  }
}

async function main() {
  const timeoutMinutes = parseTimeoutMinutes(process.argv.slice(2));
  const cfg = getDoudianConfig();

  console.log('=== 抖店等待真实买家消息验证 ===');
  console.log(`超时: ${timeoutMinutes} 分钟`);

  await ensureDependencies();

  if (!fs.existsSync(ORIGINAL_INSTALL_DIR)) {
    console.error(`原始目录不存在: ${ORIGINAL_INSTALL_DIR}`);
    process.exit(1);
  }

  killDoudianProcesses();
  await new Promise((r) => setTimeout(r, 2000));

  const { runLock, portGuard } = await beginDoudianLiveRun({
    command: 'doudian:wait-real-message',
    argv: process.argv.slice(2),
    port: cfg.bridgePort || 19527,
    reportPrefix: 'doudian-wait-real-message',
    buildTextReport: buildWaitTextReport,
  });

  const copied = await prepareTestDir();
  if (!copied.ok) {
    console.error('测试目录准备失败', copied.reason);
    process.exit(1);
  }

  const patch = await ensureTestDirPatched(TEST_INSTALL_DIR, {
    force: true,
    bridgePort: cfg.bridgePort || 19527,
  });
  if (!patch.ok) {
    console.error('asar patch 失败', patch.reason || patch.message);
    process.exit(1);
  }

  const report = await runWaitRealMessageSession({
    installDir: TEST_INSTALL_DIR,
    bridgePort: cfg.bridgePort || 19527,
    timeoutMinutes,
    dbPath: path.join(process.cwd(), 'logs', 'doudian-wait-real-message.db'),
    patchManifest: patch.manifest,
    portGuard,
    runLock,
  });

  const shopValidation = validateShopReport(report, { knownShops: cfg.knownShops || [] });
  applyShopReportValidation(report, shopValidation);

  const paths = writeReports(report, {
    prefix: 'doudian-wait-real-message',
    buildTextReport: buildWaitTextReport,
  });

  console.log('\n' + buildWaitTextReport(report).join('\n'));
  console.log('\n=== 店铺报告校验 ===');
  console.log(JSON.stringify(shopValidation, null, 2));
  console.log(`\nJSON: ${paths.jsonLatest}`);
  console.log(`TXT:  ${paths.txtLatest}`);

  process.exit(0);
}

main().catch((err) => {
  console.error('wait-real-message 异常:', err.message || err);
  process.exit(1);
});
