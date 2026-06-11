#!/usr/bin/env node
/**
 * 抖店被动监听（持续运行）
 * npm run doudian:listen-live
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { getDoudianConfig } = require('../src/shared/config');
const { applyAsarPatch } = require('../src/platforms/doudian/doudian-asar-patcher');
const { verifyAsarPatch } = require('../src/platforms/doudian/doudian-asar-patch-verify');
const { prepareTestDir } = require('./prepare-doudian-test-dir');
const { runLiveSession } = require('./lib/doudian-live-session');
const { ORIGINAL_INSTALL_DIR, TEST_INSTALL_DIR, killDoudianProcesses } = require('./lib/auto-verify-utils');

async function ensureDependencies() {
  const nodeModules = path.join(process.cwd(), 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    execSync('npm install', { stdio: 'inherit', cwd: process.cwd(), timeout: 300000 });
  }
}

async function main() {
  const cfg = getDoudianConfig();
  console.log('=== 抖店被动监听（memory cache 主入口）===');

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

  const patch = await applyAsarPatch(TEST_INSTALL_DIR, { force: true });
  if (!patch.ok) {
    console.error('asar patch 失败', patch.reason || patch.message);
    process.exit(1);
  }

  const verify = verifyAsarPatch(TEST_INSTALL_DIR, { bridgePort: cfg.bridgePort || 19527 });
  if (!verify.ok) {
    console.error('patch 校验失败');
    process.exit(1);
  }

  await runLiveSession({
    installDir: TEST_INSTALL_DIR,
    bridgePort: cfg.bridgePort || 19527,
    dbPath: path.join(process.cwd(), 'logs', 'doudian-live.db'),
  });
}

main().catch((err) => {
  console.error('listen-live 异常:', err.message || err);
  process.exit(1);
});
