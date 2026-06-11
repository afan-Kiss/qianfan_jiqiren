#!/usr/bin/env node
/**
 * 抖店引导式会话来源诊断（持续等待用户手动点开买家会话）
 * npm run doudian:inspect-conversation-sources-guided -- --timeout-minutes 30 --force-kill
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { getDoudianConfig } = require('../src/shared/config');
const { ensureTestDirPatched } = require('../src/platforms/doudian/doudian-patch-ensure');
const { prepareTestDir } = require('./prepare-doudian-test-dir');
const {
  runConversationSourcesGuidedSession,
  buildGuidedSourcesInspectTextReport,
} = require('../src/platforms/doudian/doudian-conversation-sources-session');
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
  const timeoutMinutes = parseGuidedTimeoutMinutes(argv);
  const cfg = getDoudianConfig();

  console.log('=== 抖店引导式会话来源诊断 ===');
  console.log('本命令持续等待您手动点开买家会话，检测到选中会话后退出');
  console.log(`超时: ${timeoutMinutes} 分钟`);

  await ensureDependencies();

  if (!fs.existsSync(ORIGINAL_INSTALL_DIR)) {
    console.error(`原始目录不存在: ${ORIGINAL_INSTALL_DIR}`);
    process.exit(1);
  }

  killDoudianProcesses();
  await new Promise((r) => setTimeout(r, 2000));

  const { runLock, portGuard } = await beginDoudianLiveRun({
    command: 'doudian:inspect-conversation-sources-guided',
    argv,
    port: cfg.bridgePort || 19527,
    reportPrefix: 'doudian-conversation-sources-guided',
    buildTextReport: buildGuidedSourcesInspectTextReport,
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

  const report = await runConversationSourcesGuidedSession({
    installDir: TEST_INSTALL_DIR,
    bridgePort: cfg.bridgePort || 19527,
    timeoutMinutes,
    patchManifest: patch.manifest,
    portGuard,
    runLock,
  });

  const paths = writeReports(report, {
    prefix: 'doudian-conversation-sources-guided',
    buildTextReport: buildGuidedSourcesInspectTextReport,
  });

  console.log('\n' + buildGuidedSourcesInspectTextReport(report).join('\n'));
  console.log(`\nJSON: ${paths.jsonLatest}`);
  console.log(`TXT:  ${paths.txtLatest}`);

  process.exit(report.success ? 0 : 1);
}

main().catch((err) => {
  console.error('inspect-conversation-sources-guided 异常:', err.message || err);
  process.exit(1);
});
