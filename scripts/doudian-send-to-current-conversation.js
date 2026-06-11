#!/usr/bin/env node
/**
 * 抖店向当前 IM 选中会话发送消息（UI 点击，需 --confirm-send）
 * npm run doudian:send-to-current-conversation -- --text "你好" --confirm-send
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { getDoudianConfig } = require('../src/shared/config');
const { ensureTestDirPatched } = require('../src/platforms/doudian/doudian-patch-ensure');
const { prepareTestDir } = require('./prepare-doudian-test-dir');
const {
  runSendCurrentConversationSession,
  parseSendCurrentConversationCliArgs,
  buildSendCurrentTextReport,
} = require('../src/platforms/doudian/doudian-send-current-conversation-session');
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
  const cli = parseSendCurrentConversationCliArgs(argv);
  const cfg = getDoudianConfig();

  console.log('=== 抖店向当前选中会话发送消息 ===');
  console.log(`文本长度: ${String(cli.text || '').length}`);
  console.log(`confirmSend: ${cli.confirmSend}`);
  console.log(`超时: ${cli.timeoutMinutes} 分钟`);

  await ensureDependencies();

  if (!cli.confirmSend) {
    const report = await runSendCurrentConversationSession({
      text: cli.text,
      confirmSend: false,
      mockMode: false,
    });
    const paths = writeReports(report, {
      prefix: 'doudian-send-current-conversation',
      buildTextReport: buildSendCurrentTextReport,
    });
    console.log('\n' + buildSendCurrentTextReport(report).join('\n'));
    console.log(`\nJSON: ${paths.jsonLatest}`);
    process.exit(0);
  }

  if (!String(cli.text || '').trim()) {
    console.error('缺少 --text');
    process.exit(1);
  }

  if (!fs.existsSync(ORIGINAL_INSTALL_DIR)) {
    console.error(`原始目录不存在: ${ORIGINAL_INSTALL_DIR}`);
    process.exit(1);
  }

  killDoudianProcesses();
  await new Promise((r) => setTimeout(r, 2000));

  const { runLock, portGuard } = await beginDoudianLiveRun({
    command: 'doudian:send-to-current-conversation',
    argv,
    port: cfg.bridgePort || 19527,
    reportPrefix: 'doudian-send-current-conversation',
    buildTextReport: buildSendCurrentTextReport,
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

  const report = await runSendCurrentConversationSession({
    installDir: TEST_INSTALL_DIR,
    bridgePort: cfg.bridgePort || 19527,
    timeoutMinutes: cli.timeoutMinutes,
    text: cli.text,
    confirmSend: cli.confirmSend,
    patchManifest: patch.manifest,
    portGuard,
    runLock,
  });

  const paths = writeReports(report, {
    prefix: 'doudian-send-current-conversation',
    buildTextReport: buildSendCurrentTextReport,
  });

  console.log('\n' + buildSendCurrentTextReport(report).join('\n'));
  console.log(`\nJSON: ${paths.jsonLatest}`);
  console.log(`TXT:  ${paths.txtLatest}`);

  process.exit(report.success ? 0 : 1);
}

main().catch((err) => {
  console.error('send-to-current-conversation 异常:', err.message || err);
  process.exit(1);
});
