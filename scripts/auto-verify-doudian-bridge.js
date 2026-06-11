#!/usr/bin/env node
/**
 * 一键自动验证抖店 bridge 注入链路
 * npm run doudian:auto-verify
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getDoudianConfig } = require('../src/shared/config');
const { probeCdpRoute } = require('../src/platforms/doudian/doudian-cdp-probe');
const { analyzeDoudianInstall } = require('../src/platforms/doudian/doudian-asar-analyzer');
const { applyAsarPatch } = require('../src/platforms/doudian/doudian-asar-patcher');
const { verifyAsarPatch, inspectMd5Risk } = require('../src/platforms/doudian/doudian-asar-patch-verify');
const { prepareTestDir } = require('./prepare-doudian-test-dir');
const { startBridgeAndClient } = require('./start-doudian-bridge-and-client');
const {
  ORIGINAL_INSTALL_DIR,
  TEST_INSTALL_DIR,
  getEnvInfo,
  killDoudianProcesses,
  writeReports,
  buildTextReport,
  verifyKeyFiles,
} = require('./lib/auto-verify-utils');

function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

function fail(report, step, message) {
  report.success = false;
  report.failStep = step;
  report.errors.push(message);
  log(step, `FAIL: ${message}`);
}

async function ensureDependencies(report) {
  const pkg = path.join(process.cwd(), 'package.json');
  if (!fs.existsSync(pkg)) {
    fail(report, 'check_dependencies', 'package.json 不存在');
    return false;
  }
  const nodeModules = path.join(process.cwd(), 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    log('check_dependencies', 'node_modules 不存在，正在 npm install...');
    try {
      execSync('npm install', { stdio: 'inherit', cwd: process.cwd(), timeout: 300000 });
    } catch (err) {
      fail(report, 'check_dependencies', `npm install 失败: ${err.message || err}`);
      return false;
    }
  }
  report.dependenciesOk = true;
  return true;
}

async function main() {
  const cfg = getDoudianConfig();
  const report = {
    success: false,
    failStep: '',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    originalInstallDir: ORIGINAL_INSTALL_DIR,
    testInstallDir: TEST_INSTALL_DIR,
    bridgePort: cfg.bridgePort || 19527,
    env: null,
    killProcesses: null,
    copiedFilesSummary: null,
    cdpProbe: null,
    asarAnalysis: null,
    patchResult: null,
    verifyPatchResult: null,
    startedProcesses: null,
    bridgeEvents: [],
    firstBridgeHello: null,
    firstBridgeReady: null,
    heartbeatCount: 0,
    errors: [],
    warnings: [],
    nextActions: [],
  };

  console.log('=== 抖店 bridge 一键自动验证 ===\n');

  // Step 1: 环境信息
  report.env = getEnvInfo();
  log('step1_env', `cwd=${report.env.cwd}`);
  log('step1_env', `Node=${report.env.nodeVersion} npm=${report.env.npmVersion}`);
  log('step1_env', `原始目录=${ORIGINAL_INSTALL_DIR}`);
  log('step1_env', `测试目录=${TEST_INSTALL_DIR}`);
  log('step1_env', `bridgePort=${report.bridgePort}`);
  log('step1_env', `时间=${report.env.startedAt}`);

  if (!(await ensureDependencies(report))) {
    report.finishedAt = new Date().toISOString();
    const paths = writeReports(report);
    console.log(buildTextReport(report).join('\n'));
    console.log(`\n报告: ${paths.txtLatest}`);
    process.exit(1);
  }

  if (!fs.existsSync(ORIGINAL_INSTALL_DIR)) {
    fail(report, 'check_original_dir', `原始抖店目录不存在: ${ORIGINAL_INSTALL_DIR}`);
    report.finishedAt = new Date().toISOString();
    writeReports(report);
    process.exit(1);
  }

  // Step 2: 杀进程
  log('step2_kill', '正在关闭抖店相关进程...');
  report.killProcesses = killDoudianProcesses();
  for (const k of report.killProcesses) {
    if (k.warnOnly && !k.ok) {
      report.warnings.push(`${k.process}: ${k.warning || k.output}`);
      log('step2_kill', `WARN ${k.process}: ${k.warning || '跳过'}`);
    } else if (k.ok) {
      log('step2_kill', `已结束 ${k.process}`);
    }
  }
  await new Promise((r) => setTimeout(r, 2000));

  // Step 3: 准备测试目录
  log('step3_prepare', '正在复制测试目录...');
  const prep = await prepareTestDir();
  report.copiedFilesSummary = prep;
  if (!prep.ok) {
    fail(report, 'prepare_test_dir', prep.errors?.join('; ') || prep.reason || '复制失败');
    report.finishedAt = new Date().toISOString();
    writeReports(report);
    process.exit(1);
  }
  if (prep.warnings?.length) report.warnings.push(...prep.warnings);
  log('step3_prepare', `复制完成 -> ${TEST_INSTALL_DIR}`);
  log('step3_prepare', `关键文件: ${prep.keyCheck.present.join(', ')}`);

  // CDP 探测（记录，不依赖）
  log('step3b_cdp', 'CDP 探测（仅记录）...');
  report.cdpProbe = await probeCdpRoute({ stopOnFirstDoudian: true });
  if (!report.cdpProbe.canInject) {
    report.warnings.push(`CDP 不可用: ${report.cdpProbe.reason}，走 asar patch 路线`);
    log('step3b_cdp', `CDP 不通，继续 asar 路线 (${report.cdpProbe.reason})`);
  }

  // Step 4: 分析 asar
  log('step4_analyze', '正在分析 app.asar...');
  report.asarAnalysis = analyzeDoudianInstall(TEST_INSTALL_DIR, { cdpHint: report.cdpProbe });
  const rec = report.asarAnalysis.recommendations || {};
  log('step4_analyze', `app.asar 文件数=${report.asarAnalysis.asarFileCount}`);
  log('step4_analyze', `推荐 patch=${rec.recommendedPatchTarget || rec.recommendedInjectPoint?.file || 'electron/webview_preload_index.js'}`);

  const md5Risk = inspectMd5Risk(TEST_INSTALL_DIR);
  if (md5Risk.mayValidateAppAsar) {
    report.warnings.push(`md5.json 可能校验 app.asar: ${md5Risk.note}`);
    log('step4_analyze', `WARN md5: ${md5Risk.note}`);
  } else {
    log('step4_analyze', `md5 风险: ${md5Risk.note}`);
  }

  // Step 5: patch
  log('step5_patch', '正在 patch 测试目录 app.asar...');
  report.patchResult = await applyAsarPatch(TEST_INSTALL_DIR, { force: true });
  if (!report.patchResult.ok) {
    fail(report, 'patch_asar', report.patchResult.message || report.patchResult.reason || 'patch 失败');
    report.finishedAt = new Date().toISOString();
    writeReports(report);
    process.exit(1);
  }
  log('step5_patch', `patch 完成，写入文件: ${(report.patchResult.patchedInnerFiles || []).join(', ')}`);

  // Step 6: verify patch
  log('step6_verify', '正在校验 app.asar 内注入标记...');
  report.verifyPatchResult = verifyAsarPatch(TEST_INSTALL_DIR, { bridgePort: report.bridgePort });
  if (!report.verifyPatchResult.ok) {
    fail(report, 'verify_patch', '注入标记校验失败');
    report.finishedAt = new Date().toISOString();
    writeReports(report);
    process.exit(1);
  }
  for (const f of report.verifyPatchResult.patchedFiles) {
    log('step6_verify', `✓ ${f.displayPath} marker=${f.hasPatchMarker} ws=${f.hasWsUrl}`);
  }

  // Step 7-8: 启动 WS + 测试版抖店
  log('step7_start', '正在启动本地 WS 桥和测试版抖店...');
  const bridgeRun = await startBridgeAndClient({
    installDir: TEST_INSTALL_DIR,
    bridgePort: report.bridgePort,
    waitMs: 90000,
  });

  report.startedProcesses = {
    wsStarted: bridgeRun.wsStarted,
    clientStarted: bridgeRun.clientStarted,
    clientPid: bridgeRun.clientPid,
    doudianRunningAfterStart: bridgeRun.doudianRunningAfterStart,
  };
  report.bridgeEvents = bridgeRun.bridgeEvents;
  report.firstBridgeHello = bridgeRun.firstBridgeHello;
  report.firstBridgeReady = bridgeRun.firstBridgeReady;
  report.heartbeatCount = bridgeRun.heartbeatCount;
  if (bridgeRun.warnings?.length) report.warnings.push(...bridgeRun.warnings);
  if (bridgeRun.errors?.length) report.errors.push(...bridgeRun.errors);
  if (bridgeRun.nextActions?.length) report.nextActions.push(...bridgeRun.nextActions);

  if (bridgeRun.ok) {
    report.success = true;
    report.nextActions = [
      'bridge 链路已打通，可开始接入消息监听模块',
      '如需回滚: node scripts/rollback-doudian-asar.js "' + TEST_INSTALL_DIR + '"',
      '报告路径见 logs/doudian-auto-verify-latest.txt',
    ];
    log('step8_result', 'SUCCESS: 已收到 bridge.hello / heartbeat');
  } else {
    fail(report, 'wait_bridge_events', '90 秒内未完整收到 bridge 事件');
    if (!report.startedProcesses.doudianRunningAfterStart) {
      report.nextActions.unshift('确认测试目录 doudian.exe 能正常启动');
    }
    if (report.verifyPatchResult.ok) {
      report.nextActions.unshift('patch 标记存在，可能 preload 未在客服页执行——请手动打开客服工作台后重跑 smoke');
    }
  }

  report.finishedAt = new Date().toISOString();
  const paths = writeReports(report);

  console.log('\n' + '='.repeat(50));
  console.log(buildTextReport(report).join('\n'));
  console.log('='.repeat(50));
  console.log(`\nJSON 报告: ${paths.jsonLatest}`);
  console.log(`TXT  报告: ${paths.txtLatest}`);

  if (report.success) {
    console.log('\n本次自动验证结果：成功');
    console.log('- 已自动复制测试目录');
    console.log('- 已 patch 测试目录 app.asar 内部 preload 文件');
    console.log('- 已启动测试版抖店');
    console.log(`- 已收到 bridge.hello / heartbeat (heartbeat=${report.heartbeatCount})`);
    console.log('- 下一步可以开始做消息监听');
  } else {
    console.log('\n本次自动验证结果：失败');
    console.log(`- 卡在步骤: ${report.failStep}`);
    console.log(`- 主要错误: ${report.errors.join(' | ')}`);
    console.log(`- 报告: ${paths.txtLatest}`);
  }

  process.exit(report.success ? 0 : 1);
}

main().catch((err) => {
  console.error('自动验证异常:', err.message || err);
  process.exit(1);
});
