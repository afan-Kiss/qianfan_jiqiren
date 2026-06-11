#!/usr/bin/env node
/**
 * 抖店消息流 guided：历史消息 -> WebSocket 监听 -> 向当前选中买家发送
 * npm run doudian:message-flow-guided -- --listen-minutes 5
 * npm run doudian:message-flow-guided -- --text "你好" --confirm-send --timeout-minutes 30
 * npm run doudian:message-flow-guided -- --skip-send
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { getDoudianConfig } = require('../src/shared/config');
const { ensureTestDirPatched } = require('../src/platforms/doudian/doudian-patch-ensure');
const { prepareTestDir } = require('./prepare-doudian-test-dir');
const {
  runMessageFlowGuidedSession,
  parseMessageFlowCliArgs,
  buildMessageFlowTextReport,
} = require('../src/platforms/doudian/doudian-message-flow-guided-session');
const { parseGuidedTimeoutMinutes } = require('../src/platforms/doudian/doudian-conversation-guided-shared');
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
  const cli = parseMessageFlowCliArgs(argv);
  const timeoutMinutes = parseGuidedTimeoutMinutes(argv, cli.timeoutMinutes);
  const cfg = getDoudianConfig();

  console.log('=== 抖店消息流 guided ===');
  console.log('流程: 1.获取历史消息  2.监听 WebSocket 实时消息  3.向当前选中买家发送');
  console.log(`监听时长: ${cli.listenMinutes} 分钟`);
  console.log(`超时: ${timeoutMinutes} 分钟`);
  console.log(`confirmSend: ${cli.confirmSend}`);
  console.log(`skipSend: ${cli.skipSend}`);
  console.log(`skipListen: ${cli.skipListen}`);
  console.log('阶段1: 请手动点开一个有历史消息的买家会话');

  await ensureDependencies();

  if (!fs.existsSync(ORIGINAL_INSTALL_DIR)) {
    console.error(`原始目录不存在: ${ORIGINAL_INSTALL_DIR}`);
    process.exit(1);
  }

  killDoudianProcesses();
  await new Promise((r) => setTimeout(r, 2000));

  const { runLock, portGuard } = await beginDoudianLiveRun({
    command: 'doudian:message-flow-guided',
    argv,
    port: cfg.bridgePort || 19527,
    reportPrefix: 'doudian-message-flow-guided',
    buildTextReport: buildMessageFlowTextReport,
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

  const report = await runMessageFlowGuidedSession({
    installDir: TEST_INSTALL_DIR,
    bridgePort: cfg.bridgePort || 19527,
    timeoutMinutes,
    listenMinutes: cli.listenMinutes,
    text: cli.text,
    confirmSend: cli.confirmSend,
    skipSend: cli.skipSend,
    skipListen: cli.skipListen,
    dbPath: path.join(process.cwd(), 'logs', 'doudian-message-flow-guided.db'),
    patchManifest: patch.manifest,
    portGuard,
    runLock,
  });

  const paths = writeReports(report, {
    prefix: 'doudian-message-flow-guided',
    buildTextReport: buildMessageFlowTextReport,
  });

  console.log('\n' + buildMessageFlowTextReport(report).join('\n'));
  console.log(`\nJSON: ${paths.jsonLatest}`);
  console.log(`TXT:  ${paths.txtLatest}`);

  process.exit(report.success ? 0 : 1);
}

main().catch((err) => {
  console.error('message-flow-guided 异常:', err.message || err);
  process.exit(1);
});
