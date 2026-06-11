#!/usr/bin/env node
/**
 * 抖店会话来源诊断（memory cache / React Fiber / DOM 几何 / 选中兜底）
 * npm run doudian:inspect-conversation-sources
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { getDoudianConfig } = require('../src/shared/config');
const { ensureTestDirPatched } = require('../src/platforms/doudian/doudian-patch-ensure');
const { prepareTestDir } = require('./prepare-doudian-test-dir');
const {
  runConversationSourcesInspectSession,
  buildSourcesInspectTextReport,
} = require('../src/platforms/doudian/doudian-conversation-sources-session');
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
  const cfg = getDoudianConfig();

  console.log('=== 抖店会话来源诊断 ===');

  await ensureDependencies();

  if (!fs.existsSync(ORIGINAL_INSTALL_DIR)) {
    console.error(`原始目录不存在: ${ORIGINAL_INSTALL_DIR}`);
    process.exit(1);
  }

  killDoudianProcesses();
  await new Promise((r) => setTimeout(r, 2000));

  const { runLock, portGuard } = await beginDoudianLiveRun({
    command: 'doudian:inspect-conversation-sources',
    argv,
    port: cfg.bridgePort || 19527,
    reportPrefix: 'doudian-conversation-sources',
    buildTextReport: buildSourcesInspectTextReport,
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

  const report = await runConversationSourcesInspectSession({
    installDir: TEST_INSTALL_DIR,
    bridgePort: cfg.bridgePort || 19527,
    patchManifest: patch.manifest,
    portGuard,
    runLock,
  });

  const paths = writeReports(report, {
    prefix: 'doudian-conversation-sources',
    buildTextReport: buildSourcesInspectTextReport,
  });

  console.log('\n' + buildSourcesInspectTextReport(report).join('\n'));
  console.log(`\nJSON: ${paths.jsonLatest}`);
  console.log(`TXT:  ${paths.txtLatest}`);

  process.exit(report.success ? 0 : 1);
}

main().catch((err) => {
  console.error('inspect-conversation-sources 异常:', err.message || err);
  process.exit(1);
});
