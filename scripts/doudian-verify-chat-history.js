#!/usr/bin/env node
/**
 * 抖店聊天历史验证
 * npm run doudian:verify-chat-history
 * npm run doudian:verify-chat-history -- --timeout-minutes 30
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { getDoudianConfig } = require('../src/shared/config');
const { ensureTestDirPatched } = require('../src/platforms/doudian/doudian-patch-ensure');
const { prepareTestDir } = require('./prepare-doudian-test-dir');
const {
  runChatHistorySession,
  parseTimeoutMinutes,
  buildHistoryTextReport,
} = require('./lib/doudian-chat-history-session');
const {
  ORIGINAL_INSTALL_DIR,
  TEST_INSTALL_DIR,
  killDoudianProcesses,
  writeReports,
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

  console.log('=== 抖店聊天历史验证 ===');
  console.log(`超时: ${timeoutMinutes} 分钟`);

  await ensureDependencies();

  if (!fs.existsSync(ORIGINAL_INSTALL_DIR)) {
    console.error(`原始目录不存在: ${ORIGINAL_INSTALL_DIR}`);
    process.exit(1);
  }

  killDoudianProcesses();
  await new Promise((r) => setTimeout(r, 2000));

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

  const report = await runChatHistorySession({
    installDir: TEST_INSTALL_DIR,
    bridgePort: cfg.bridgePort || 19527,
    timeoutMinutes,
    dbPath: path.join(process.cwd(), 'logs', 'doudian-chat-history.db'),
    patchManifest: patch.manifest,
  });

  const shopValidation = validateShopReport(report, { knownShops: cfg.knownShops || [] });
  applyShopReportValidation(report, shopValidation);

  const paths = writeReports(report, {
    prefix: 'doudian-chat-history',
    buildTextReport: buildHistoryTextReport,
  });

  console.log('\n' + buildHistoryTextReport(report).join('\n'));
  console.log(`\nJSON: ${paths.jsonLatest}`);
  console.log(`TXT:  ${paths.txtLatest}`);

  if (['no_selected_conversation', 'selected_conversation_name_is_ui_noise'].includes(report.reason)) {
    process.exit(0);
  }
  process.exit(report.success ? 0 : 1);
}

main().catch((err) => {
  console.error('verify-chat-history 异常:', err.message || err);
  process.exit(1);
});
