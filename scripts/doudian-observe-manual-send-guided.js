#!/usr/bin/env node
/**
 * 手动发送抓包诊断：用户手动点发送，记录网络请求与聊天区变化
 * npm run doudian:observe-manual-send-guided -- --timeout-minutes 15
 * npm run doudian:observe-manual-send-guided -- --no-restart   # 不杀已有抖店进程
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { getDoudianConfig } = require('../src/shared/config');
const { ensureTestDirPatched } = require('../src/platforms/doudian/doudian-patch-ensure');
const { prepareTestDir } = require('./prepare-doudian-test-dir');
const {
  runObserveManualSendGuidedSession,
  parseObserveManualSendCliArgs,
  buildObserveManualSendTextReport,
} = require('../src/platforms/doudian/doudian-observe-manual-send-session');
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
  const cli = parseObserveManualSendCliArgs(argv);
  const timeoutMinutes = parseGuidedTimeoutMinutes(argv, cli.timeoutMinutes);
  const cfg = getDoudianConfig();

  console.log('=== 抖店手动发送抓包诊断 ===');
  console.log('步骤: 1.手动点开买家  2.等基线+20秒  3.您在输入框手动发送并点发送按钮');
  console.log(`超时: ${timeoutMinutes} 分钟`);
  console.log(`noRestart: ${cli.noRestart}`);

  await ensureDependencies();

  if (!fs.existsSync(ORIGINAL_INSTALL_DIR)) {
    console.error(`原始目录不存在: ${ORIGINAL_INSTALL_DIR}`);
    process.exit(1);
  }

  if (!cli.noRestart) {
    killDoudianProcesses();
    await new Promise((r) => setTimeout(r, 2000));
  } else {
    console.log('[抖店桥] --no-restart: 保留当前抖店窗口，不强制重启');
  }

  const { runLock, portGuard } = await beginDoudianLiveRun({
    command: 'doudian:observe-manual-send-guided',
    argv,
    port: cfg.bridgePort || 19527,
    reportPrefix: 'doudian-observe-manual-send-guided',
    buildTextReport: buildObserveManualSendTextReport,
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

  const report = await runObserveManualSendGuidedSession({
    installDir: TEST_INSTALL_DIR,
    bridgePort: cfg.bridgePort || 19527,
    timeoutMinutes,
    exitOnDetect: cli.exitOnDetect,
    keepClientAlive: true,
    dbPath: path.join(process.cwd(), 'logs', 'doudian-observe-manual-send-guided.db'),
    patchManifest: patch.manifest,
    portGuard,
    runLock,
  });

  const paths = writeReports(report, {
    prefix: 'doudian-observe-manual-send-guided',
    buildTextReport: buildObserveManualSendTextReport,
  });

  console.log('\n' + buildObserveManualSendTextReport(report).join('\n'));
  console.log(`\nJSON: ${paths.jsonLatest}`);
  console.log(`TXT:  ${paths.txtLatest}`);

  process.exit(report.success ? 0 : 1);
}

main().catch((err) => {
  console.error('observe-manual-send-guided 异常:', err.message || err);
  process.exit(1);
});
