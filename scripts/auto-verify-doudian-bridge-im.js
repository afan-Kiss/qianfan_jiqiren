#!/usr/bin/env node
/**
 * 一键自动验证抖店 IM 客服页 bridge
 * npm run doudian:auto-verify-im
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getDoudianConfig } = require('../src/shared/config');
const { probeCdpRoute } = require('../src/platforms/doudian/doudian-cdp-probe');
const { analyzeDoudianInstall } = require('../src/platforms/doudian/doudian-asar-analyzer');
const { ensureTestDirPatched } = require('../src/platforms/doudian/doudian-patch-ensure');
const { verifyAsarPatch, inspectMd5Risk } = require('../src/platforms/doudian/doudian-asar-patch-verify');
const { prepareTestDir } = require('./prepare-doudian-test-dir');
const { startBridgeAndClient } = require('./start-doudian-bridge-and-client');
const {
  ORIGINAL_INSTALL_DIR,
  TEST_INSTALL_DIR,
  getEnvInfo,
  killDoudianProcesses,
  writeReports,
  buildImTextReport,
  beginDoudianLiveRun,
} = require('./lib/auto-verify-utils');

const IM_WAIT_MS = 180000;

function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

function fail(report, step, message) {
  report.success = false;
  report.imBridgeSuccess = false;
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
    imBridgeSuccess: false,
    homepageBridgeSuccess: false,
    failStep: '',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    originalInstallDir: ORIGINAL_INSTALL_DIR,
    testInstallDir: TEST_INSTALL_DIR,
    bridgePort: cfg.bridgePort || 19527,
    imWaitMs: IM_WAIT_MS,
    env: null,
    killProcesses: null,
    copiedFilesSummary: null,
    cdpProbe: null,
    asarAnalysis: null,
    patchResult: null,
    verifyPatchResult: null,
    startedProcesses: null,
    bridgeEvents: [],
    allBridges: [],
    bridgeCount: 0,
    firstHomepageBridge: null,
    firstImBridge: null,
    firstBridgeHello: null,
    firstBridgeReady: null,
    heartbeatCount: 0,
    imHeartbeatCount: 0,
    imOpenAttempts: [],
    stdoutImHints: 0,
    errors: [],
    warnings: [],
    nextActions: [],
    portGuard: null,
    runLock: null,
  };

  console.log('=== 抖店 IM 客服页 bridge 一键自动验证 ===\n');

  report.env = getEnvInfo();
  log('step1_env', `cwd=${report.env.cwd}`);
  log('step1_env', `Node=${report.env.nodeVersion} npm=${report.env.npmVersion}`);
  log('step1_env', `测试目录=${TEST_INSTALL_DIR}`);
  log('step1_env', `imWaitMs=${IM_WAIT_MS}`);

  if (!(await ensureDependencies(report))) {
    report.finishedAt = new Date().toISOString();
    writeReports(report, { prefix: 'doudian-auto-verify-im', buildTextReport: buildImTextReport });
    process.exit(1);
  }

  if (!fs.existsSync(ORIGINAL_INSTALL_DIR)) {
    fail(report, 'check_original_dir', `原始抖店目录不存在: ${ORIGINAL_INSTALL_DIR}`);
    report.finishedAt = new Date().toISOString();
    writeReports(report, { prefix: 'doudian-auto-verify-im', buildTextReport: buildImTextReport });
    process.exit(1);
  }

  const liveBegin = await beginDoudianLiveRun({
    command: 'doudian:auto-verify-im',
    argv: process.argv.slice(2),
    port: report.bridgePort,
    reportPrefix: 'doudian-auto-verify-im',
    buildTextReport: buildImTextReport,
  });
  report.runLock = liveBegin.runLock;
  report.portGuard = liveBegin.portGuard;

  log('step2_kill', '正在关闭抖店相关进程...');
  report.killProcesses = killDoudianProcesses();
  for (const k of report.killProcesses) {
    if (k.warnOnly && !k.ok) {
      report.warnings.push(`${k.process}: ${k.warning || k.output}`);
    }
  }
  await new Promise((r) => setTimeout(r, 2000));

  log('step3_prepare', '正在复制测试目录...');
  const prep = await prepareTestDir();
  report.copiedFilesSummary = prep;
  if (!prep.ok) {
    fail(report, 'prepare_test_dir', prep.errors?.join('; ') || prep.reason || '复制失败');
    report.finishedAt = new Date().toISOString();
    writeReports(report, { prefix: 'doudian-auto-verify-im', buildTextReport: buildImTextReport });
    process.exit(1);
  }
  if (prep.warnings?.length) report.warnings.push(...prep.warnings);

  log('step3b_cdp', 'CDP 探测（仅记录）...');
  report.cdpProbe = await probeCdpRoute({ stopOnFirstDoudian: true });
  if (!report.cdpProbe.canInject) {
    report.warnings.push(`CDP 不可用: ${report.cdpProbe.reason}`);
  }

  log('step4_analyze', '正在分析 app.asar...');
  report.asarAnalysis = analyzeDoudianInstall(TEST_INSTALL_DIR, { cdpHint: report.cdpProbe });
  const md5Risk = inspectMd5Risk(TEST_INSTALL_DIR);
  if (md5Risk.mayValidateAppAsar) report.warnings.push(`md5 风险: ${md5Risk.note}`);

  log('step5_patch', '正在 patch 测试目录（含 debug 命令注入）...');
  report.patchResult = await ensureTestDirPatched(TEST_INSTALL_DIR, {
    force: true,
    bridgePort: report.bridgePort,
  });
  if (!report.patchResult.ok) {
    fail(report, 'patch_asar', report.patchResult.message || report.patchResult.reason || 'patch 失败');
    report.finishedAt = new Date().toISOString();
    writeReports(report, { prefix: 'doudian-auto-verify-im', buildTextReport: buildImTextReport });
    process.exit(1);
  }

  log('step6_verify', '正在校验 patch 标记...');
  report.verifyPatchResult = report.patchResult.verify || verifyAsarPatch(TEST_INSTALL_DIR, { bridgePort: report.bridgePort });
  report.patchManifest = report.patchResult.manifest || null;
  if (!report.verifyPatchResult.ok) {
    fail(report, 'verify_patch', '注入标记校验失败');
    report.finishedAt = new Date().toISOString();
    writeReports(report, { prefix: 'doudian-auto-verify-im', buildTextReport: buildImTextReport });
    process.exit(1);
  }

  log('step7_start', `启动 WS + 测试版抖店，等待 IM bridge（${IM_WAIT_MS / 1000}s）...`);
  const bridgeRun = await startBridgeAndClient({
    installDir: TEST_INSTALL_DIR,
    bridgePort: report.bridgePort,
    imMode: true,
    waitMs: IM_WAIT_MS,
  });

  report.startedProcesses = {
    wsStarted: bridgeRun.wsStarted,
    clientStarted: bridgeRun.clientStarted,
    clientPid: bridgeRun.clientPid,
    doudianRunningAfterStart: bridgeRun.doudianRunningAfterStart,
  };
  report.bridgeEvents = bridgeRun.bridgeEvents;
  report.allBridges = bridgeRun.allBridges;
  report.bridgeCount = bridgeRun.bridgeCount;
  report.firstHomepageBridge = bridgeRun.firstHomepageBridge;
  report.firstImBridge = bridgeRun.firstImBridge;
  report.firstBridgeHello = bridgeRun.firstBridgeHello;
  report.firstBridgeReady = bridgeRun.firstBridgeReady;
  report.heartbeatCount = bridgeRun.heartbeatCount;
  report.imHeartbeatCount = bridgeRun.imHeartbeatCount;
  report.imOpenAttempts = bridgeRun.imOpenAttempts;
  report.stdoutImHints = bridgeRun.stdoutImHints;
  report.homepageBridgeSuccess = bridgeRun.homepageBridgeSuccess;
  report.imBridgeSuccess = bridgeRun.imBridgeSuccess;
  if (bridgeRun.warnings?.length) report.warnings.push(...bridgeRun.warnings);
  if (bridgeRun.errors?.length) report.errors.push(...bridgeRun.errors);

  if (bridgeRun.ok && bridgeRun.imBridgeSuccess) {
    report.success = true;
    report.imBridgeSuccess = true;
    report.nextActions = [
      'IM 客服页 bridge 已打通，可进入下一步消息监听',
      '如需回滚: node scripts/rollback-doudian-asar.js "' + TEST_INSTALL_DIR + '"',
    ];
    log('step8_result', 'SUCCESS: IM 客服页 bridge 已连通');
  } else {
    report.failStep = bridgeRun.failStep || 'im_bridge_not_seen';
    report.nextActions = bridgeRun.nextActions?.length
      ? bridgeRun.nextActions
      : ['手动打开 IM 客服页后重跑 npm run doudian:auto-verify-im'];
    fail(report, report.failStep, 'IM 客服页 bridge 未在时限内连通');
  }

  report.finishedAt = new Date().toISOString();
  const paths = writeReports(report, { prefix: 'doudian-auto-verify-im', buildTextReport: buildImTextReport });

  console.log('\n' + '='.repeat(50));
  console.log(buildImTextReport(report).join('\n'));
  console.log('='.repeat(50));
  console.log(`\nJSON 报告: ${paths.jsonLatest}`);
  console.log(`TXT  报告: ${paths.txtLatest}`);

  if (report.imBridgeSuccess) {
    console.log('\nIM 客服页 bridge 已打通，可以进入下一步消息监听。');
  } else {
    console.log('\n首页 bridge 已打通，但 IM 页 bridge 没打通。');
    console.log(`卡点是：${report.failStep}`);
    console.log(`下一步建议：${(report.nextActions || []).join('；')}`);
  }

  process.exit(report.imBridgeSuccess ? 0 : 1);
}

main().catch((err) => {
  console.error('IM 自动验证异常:', err.message || err);
  process.exit(1);
});
