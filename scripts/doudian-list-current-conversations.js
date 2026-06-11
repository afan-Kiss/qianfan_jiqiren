#!/usr/bin/env node
/**
 * 抖店读取当前 IM 会话列表（不点击、不发送）
 * npm run doudian:list-current-conversations
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { getDoudianConfig } = require('../src/shared/config');
const { ensureTestDirPatched } = require('../src/platforms/doudian/doudian-patch-ensure');
const { prepareTestDir } = require('./prepare-doudian-test-dir');
const {
  runConversationListSession,
  parseListConversationsCliArgs,
  buildConversationListTextReport,
} = require('../src/platforms/doudian/doudian-conversation-list-session');
const {
  ORIGINAL_INSTALL_DIR,
  TEST_INSTALL_DIR,
  killDoudianProcesses,
  writeReports,
  beginDoudianLiveRun,
} = require('./lib/auto-verify-utils');

async function ensureDependencies() {
  const nodeModules = path.join(process.cwd(), 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    execSync('npm install', { stdio: 'inherit', cwd: process.cwd(), timeout: 300000 });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cli = parseListConversationsCliArgs(argv);
  const cfg = getDoudianConfig();

  console.log('=== 抖店读取当前会话列表 ===');
  console.log(`超时: ${cli.timeoutMinutes} 分钟`);

  await ensureDependencies();

  if (!fs.existsSync(ORIGINAL_INSTALL_DIR)) {
    console.error(`原始目录不存在: ${ORIGINAL_INSTALL_DIR}`);
    process.exit(1);
  }

  killDoudianProcesses();
  await new Promise((r) => setTimeout(r, 2000));

  const { runLock, portGuard } = await beginDoudianLiveRun({
    command: 'doudian:list-current-conversations',
    argv,
    port: cfg.bridgePort || 19527,
    reportPrefix: 'doudian-current-conversations',
    buildTextReport: buildConversationListTextReport,
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

  const report = await runConversationListSession({
    installDir: TEST_INSTALL_DIR,
    bridgePort: cfg.bridgePort || 19527,
    timeoutMinutes: cli.timeoutMinutes,
    patchManifest: patch.manifest,
    portGuard,
    runLock,
  });

  const paths = writeReports(report, {
    prefix: 'doudian-current-conversations',
    buildTextReport: buildConversationListTextReport,
  });

  console.log('\n' + buildConversationListTextReport(report).join('\n'));
  console.log(`\nJSON: ${paths.jsonLatest}`);
  console.log(`TXT:  ${paths.txtLatest}`);

  process.exit(report.success ? 0 : 1);
}

main().catch((err) => {
  console.error('list-current-conversations 异常:', err.message || err);
  process.exit(1);
});
