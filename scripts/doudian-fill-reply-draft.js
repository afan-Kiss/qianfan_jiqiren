#!/usr/bin/env node
/**
 * 抖店草稿填入输入框（不点击发送）
 * npm run doudian:fill-reply-draft
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { getDoudianConfig } = require('../src/shared/config');
const { ensureTestDirPatched } = require('../src/platforms/doudian/doudian-patch-ensure');
const { prepareTestDir } = require('./prepare-doudian-test-dir');
const {
  runReplyEditorSession,
  buildFillDraftTextReport,
  parseTimeoutMinutes,
} = require('../src/platforms/doudian/doudian-reply-draft-fill-session');
const {
  ORIGINAL_INSTALL_DIR,
  TEST_INSTALL_DIR,
  killDoudianProcesses,
  writeReports,
} = require('./lib/auto-verify-utils');

async function ensureDependencies() {
  const nodeModules = path.join(process.cwd(), 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    execSync('npm install', { stdio: 'inherit', cwd: process.cwd(), timeout: 300000 });
  }
}

async function main() {
  const timeoutMinutes = parseTimeoutMinutes(process.argv.slice(2));
  const cfg = getDoudianConfig();

  console.log('=== 抖店草稿填入输入框 ===');
  console.log('本命令仅把 draft_only 草稿填入输入框，不点击发送、不调用发送接口');
  console.log(`超时: ${timeoutMinutes} 分钟`);
  console.log('请在 IM 打开后手动选中与草稿匹配的买家会话');

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

  const report = await runReplyEditorSession({
    mode: 'fill',
    installDir: TEST_INSTALL_DIR,
    bridgePort: cfg.bridgePort || 19527,
    timeoutMinutes,
    patchManifest: patch.manifest,
    dbPath: path.join(process.cwd(), 'logs', 'doudian-chat-history-guided.db'),
  });

  const paths = writeReports(report, {
    prefix: 'doudian-fill-reply-draft',
    buildTextReport: buildFillDraftTextReport,
  });

  console.log('\n' + buildFillDraftTextReport(report).join('\n'));
  console.log(`\nJSON: ${paths.jsonLatest}`);
  console.log(`TXT:  ${paths.txtLatest}`);

  process.exit(report.success ? 0 : 1);
}

main().catch((err) => {
  console.error('fill-reply-draft 异常:', err.message || err);
  process.exit(1);
});
