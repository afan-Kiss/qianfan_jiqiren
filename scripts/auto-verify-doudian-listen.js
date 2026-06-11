#!/usr/bin/env node
/**
 * 多店铺 IM 消息监听自动验证
 * npm run doudian:auto-verify-listen
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getDoudianConfig } = require('../src/shared/config');
const { applyAsarPatch } = require('../src/platforms/doudian/doudian-asar-patcher');
const { verifyAsarPatch } = require('../src/platforms/doudian/doudian-asar-patch-verify');
const { prepareTestDir } = require('./prepare-doudian-test-dir');
const { runListenSession } = require('./lib/doudian-listen-session');
const {
  ORIGINAL_INSTALL_DIR,
  TEST_INSTALL_DIR,
  getEnvInfo,
  killDoudianProcesses,
  writeReports,
  buildListenTextReport,
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

async function ensureDependencies() {
  const nodeModules = path.join(process.cwd(), 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    execSync('npm install', { stdio: 'inherit', cwd: process.cwd(), timeout: 300000 });
  }
}

async function main() {
  const cfg = getDoudianConfig();
  const report = {
    success: false,
    multiShopDetected: false,
    shopCount: 0,
    shops: [],
    unknownBridges: [],
    allBridges: [],
    homepageBridgeSuccess: false,
    imBridgeSuccess: false,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    originalInstallDir: ORIGINAL_INSTALL_DIR,
    testInstallDir: TEST_INSTALL_DIR,
    bridgePort: cfg.bridgePort || 19527,
    listenWaitMs: 180000,
    env: null,
    killProcesses: null,
    copiedFilesSummary: null,
    patchResult: null,
    verifyPatchResult: null,
    listenResult: null,
    observerStartedCount: 0,
    normalizedMessageCount: 0,
    dedupedMessageCount: 0,
    insertedMessageCount: 0,
    sampleMessages: [],
    imOpenAttempts: [],
    errors: [],
    warnings: [],
    nextActions: [],
    failStep: '',
  };

  console.log('=== 抖店多店铺 IM 消息监听自动验证 ===\n');

  report.env = getEnvInfo();
  log('step1_env', `测试目录=${TEST_INSTALL_DIR} listenWaitMs=180000`);

  await ensureDependencies();

  if (!fs.existsSync(ORIGINAL_INSTALL_DIR)) {
    fail(report, 'check_original_dir', `原始目录不存在: ${ORIGINAL_INSTALL_DIR}`);
    report.finishedAt = new Date().toISOString();
    writeReports(report, { prefix: 'doudian-auto-verify-listen', buildTextReport: buildListenTextReport });
    process.exit(1);
  }

  log('step2_kill', '关闭抖店进程...');
  report.killProcesses = killDoudianProcesses();
  await new Promise((r) => setTimeout(r, 2000));

  log('step3_prepare', '准备测试目录...');
  report.copiedFilesSummary = await prepareTestDir();
  if (!report.copiedFilesSummary.ok) {
    fail(report, 'prepare_test_dir', report.copiedFilesSummary.reason || '复制失败');
    report.finishedAt = new Date().toISOString();
    writeReports(report, { prefix: 'doudian-auto-verify-listen', buildTextReport: buildListenTextReport });
    process.exit(1);
  }

  log('step4_patch', 'patch 测试目录（含 message observer）...');
  report.patchResult = await applyAsarPatch(TEST_INSTALL_DIR, { force: true });
  if (!report.patchResult.ok) {
    fail(report, 'patch_asar', report.patchResult.message || report.patchResult.reason || 'patch 失败');
    report.finishedAt = new Date().toISOString();
    writeReports(report, { prefix: 'doudian-auto-verify-listen', buildTextReport: buildListenTextReport });
    process.exit(1);
  }

  log('step5_verify', '校验 patch...');
  report.verifyPatchResult = verifyAsarPatch(TEST_INSTALL_DIR, { bridgePort: report.bridgePort });
  if (!report.verifyPatchResult.ok) {
    fail(report, 'verify_patch', 'patch 校验失败');
    report.finishedAt = new Date().toISOString();
    writeReports(report, { prefix: 'doudian-auto-verify-listen', buildTextReport: buildListenTextReport });
    process.exit(1);
  }

  log('step6_listen', '启动监听验证（180s）...');
  const listen = await runListenSession({
    installDir: TEST_INSTALL_DIR,
    bridgePort: report.bridgePort,
    waitMs: 180000,
    verifyDbPath: path.join(process.cwd(), 'logs', 'doudian-listen-verify.db'),
  });

  report.listenResult = listen;
  Object.assign(report, {
    success: listen.success,
    bridgeSuccess: listen.bridgeSuccess,
    observerReady: listen.observerReady,
    shopIdentitySuccess: listen.shopIdentitySuccess,
    businessDataCaptured: listen.businessDataCaptured,
    realMessageCandidateCaptured: listen.realMessageCandidateCaptured,
    onlyUiNoiseCaptured: listen.onlyUiNoiseCaptured,
    multiShopDetected: listen.multiShopDetected,
    shopCount: listen.shopCount,
    loggedInShopCount: listen.loggedInShopCount,
    activeImShopCount: listen.activeImShopCount,
    inactiveShopCount: listen.inactiveShopCount,
    loggedInShops: listen.loggedInShops,
    activeImShops: listen.activeImShops,
    inactiveShops: listen.inactiveShops,
    shops: listen.shops,
    unknownBridges: listen.unknownBridges,
    unknownImBridges: listen.unknownImBridges,
    allBridges: listen.allBridges,
    homepageBridgeSuccess: listen.homepageBridgeSuccess,
    imBridgeSuccess: listen.imBridgeSuccess,
    domDiagnosticSuccess: listen.domDiagnosticSuccess,
    messageCandidateSuccess: listen.messageCandidateSuccess,
    sqliteInsertSuccess: listen.sqliteInsertSuccess,
    observerStartedCount: listen.observerStartedCount,
    observerReadyCount: listen.observerReadyCount,
    shopIdentityResolvedCount: listen.shopIdentityResolvedCount,
    imDomDiagnosticCount: listen.imDomDiagnosticCount,
    emptyStateDetected: listen.emptyStateDetected,
    conversationEmptyDetected: listen.conversationEmptyDetected,
    networkReplayCount: listen.networkReplayCount,
    networkShopInfoCount: listen.networkShopInfoCount,
    domCandidateCount: listen.domCandidateCount,
    domCandidateSamples: listen.domCandidateSamples,
    networkCandidateSamples: listen.networkCandidateSamples,
    shopIdentitySamples: listen.shopIdentitySamples,
    unresolvedImBridges: listen.unresolvedImBridges,
    normalizedMessageCount: listen.normalizedMessageCount,
    dedupedMessageCount: listen.dedupedMessageCount,
    insertedMessageCount: listen.insertedMessageCount,
    sampleMessages: listen.sampleMessages,
    uiNoiseCount: listen.uiNoiseCount,
    uiNoiseSamples: listen.uiNoiseSamples,
    workerNetworkCandidateCount: listen.workerNetworkCandidateCount,
    memoryCacheCandidateCount: listen.memoryCacheCandidateCount,
    stdoutBusinessSignalCount: listen.stdoutBusinessSignalCount,
    pigeonApiSignals: listen.pigeonApiSignals,
    currentUserCaptured: listen.currentUserCaptured,
    conversationListCaptured: listen.conversationListCaptured,
    linkInfoCaptured: listen.linkInfoCaptured,
    realConversationCount: listen.realConversationCount,
    realMessageCandidateCount: listen.realMessageCandidateCount,
    realMessageSamples: listen.realMessageSamples,
    stdoutBusinessSignal: listen.stdoutBusinessSignal,
    memoryCacheBusinessEventCount: listen.memoryCacheBusinessEventCount,
    shopIdentityEventCount: listen.shopIdentityEventCount,
    conversationListEventCount: listen.conversationListEventCount,
    conversationEmptyEventCount: listen.conversationEmptyEventCount,
    realMessageCandidateEventCount: listen.realMessageCandidateEventCount,
    platformConversationUpsertCount: listen.platformConversationUpsertCount,
    platformMessageInsertCount: listen.platformMessageInsertCount,
    parserFixtureSuggested: listen.parserFixtureSuggested,
    imOpenAttempts: listen.imOpenAttempts,
    failStep: listen.failStep || '',
  });
  report.errors.push(...listen.errors);
  report.warnings.push(...listen.warnings);
  report.nextActions = listen.nextActions;

  report.finishedAt = new Date().toISOString();
  const paths = writeReports(report, {
    prefix: 'doudian-auto-verify-listen',
    buildTextReport: buildListenTextReport,
  });

  console.log('\n' + '='.repeat(50));
  console.log(buildListenTextReport(report).join('\n'));
  console.log('='.repeat(50));
  console.log(`\nJSON: ${paths.jsonLatest}`);
  console.log(`TXT:  ${paths.txtLatest}`);

  if (report.success) {
    console.log('\n多店铺 IM 消息监听验证：成功');
  } else {
    console.log(`\n多店铺 IM 消息监听验证：失败（${report.failStep}）`);
  }

  process.exit(report.success ? 0 : 1);
}

main().catch((err) => {
  console.error('listen 验证异常:', err.message || err);
  process.exit(1);
});
