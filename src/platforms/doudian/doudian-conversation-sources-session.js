const { getDoudianConfig } = require('../../shared/config');
const { DOUDIAN_EVENTS } = require('./doudian-types');
const {
  applyMergedSourcesToReport,
  sanitizeSourcesInspectionReport,
  buildSourcesSummary,
} = require('./doudian-conversation-sources-resolver');
const {
  createImLiveContext,
  bootstrapImLiveClient,
  sleep,
  DEFAULT_TIMEOUT_MINUTES,
  HINTS_INTERVAL_MS,
} = require('./doudian-im-live-shared');
const { applyIntegrityWarningsToReport } = require('./doudian-integrity-warning-monitor');
const { formatConversationListTerminal } = require('./doudian-conversation-list-parser');
const {
  GUIDED_POLL_MS,
  GUIDED_BRIEFING_MS,
  GUIDED_DEFAULT_TIMEOUT_MINUTES,
  isGuidedConversationReady,
  printGuidedConversationBriefing,
  syncGuidedSourceCounts,
  applyEmptyStateFlags,
} = require('./doudian-conversation-guided-shared');

const INSPECT_TIMEOUT_MS = 90000;
const INSPECT_WARMUP_MS = 10000;
const POLL_MS = 2000;

function buildSourcesInspectTextReport(report) {
  const lines = [];
  lines.push('=== 抖店会话来源诊断报告 ===');
  lines.push(`时间: ${report.finishedAt || new Date().toISOString()}`);
  lines.push(`结果: ${report.success ? '成功' : '失败'}`);
  lines.push(`reason: ${report.reason || ''}`);
  lines.push(`memoryCacheCount: ${report.summary?.memoryCacheCount || 0}`);
  lines.push(`reactFiberCount: ${report.summary?.reactFiberCount || 0}`);
  lines.push(`domGeometryCount: ${report.summary?.domGeometryCount || 0}`);
  lines.push(`selectedConversationDetected: ${report.summary?.selectedConversationDetected || false}`);
  lines.push(`sendAllowedBySelectedConversation: ${report.summary?.sendAllowedBySelectedConversation || false}`);
  lines.push(`primaryListSource: ${report.summary?.primaryListSource || 'none'}`);
  if (report.selectedConversation) {
    const s = report.selectedConversation;
    lines.push(`selected: ${s.buyerName || ''} / ${s.buyerId || ''} / ${s.conversationId || ''}`);
  }
  if (report.warnings?.length) {
    lines.push('Warnings:');
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  lines.push('');
  lines.push(...formatConversationListTerminal(report.conversations || [], report.selectedConversation || {}));
  return lines;
}

function buildMockSourcesInspection(scenario = 'full') {
  const base = {
    success: true,
    reason: 'conversation_sources_inspected',
    shopInfo: { shopId: '263636465', shopName: 'XY祥钰珠宝' },
    memoryCache: {
      source: 'memory_cache',
      apiName: 'get_current_conversation_list',
      conversationCount: 2,
      conversations: [
        {
          buyerId: 'buyer_qingwa_001',
          buyerName: '一只小青蛙',
          conversationId: 'conv_qingwa_001',
          lastMessage: '用户超时未回复，系统关闭会话',
          selected: true,
        },
        {
          buyerId: 'buyer_other_002',
          buyerName: '测试买家B',
          conversationId: 'conv_other_002',
          lastMessage: '你好',
          selected: false,
        },
      ],
      selectedConversation: {
        buyerId: 'buyer_qingwa_001',
        buyerName: '一只小青蛙',
        conversationId: 'conv_qingwa_001',
        selected: true,
      },
    },
    reactFiber: {
      source: 'react_fiber',
      fiberNodeCount: 12,
      conversationLikeObjectCount: 1,
      conversations: [
        {
          buyerId: 'buyer_qingwa_001',
          buyerName: '一只小青蛙',
          conversationId: 'conv_qingwa_001',
          selected: true,
        },
      ],
      selectedConversation: {
        buyerId: 'buyer_qingwa_001',
        buyerName: '一只小青蛙',
        conversationId: 'conv_qingwa_001',
      },
    },
    domList: {
      source: 'dom_geometry',
      itemCount: 1,
      items: [
        {
          buyerName: '一只小青蛙',
          lastMessage: '用户超时未回复，系统关闭会话',
          timeText: '18:12',
          selected: true,
          score: 35,
        },
      ],
    },
    selectedConversation: {
      selectedConversationDetected: true,
      buyerId: 'buyer_qingwa_001',
      buyerName: '一只小青蛙',
      conversationId: 'conv_qingwa_001',
      buyerNameSource: 'chat_header',
      conversationIdSource: 'memory_cache',
      confidence: 72,
      sources: ['memory_cache', 'chat_header', 'dom_geometry_active'],
    },
  };
  if (scenario === 'selected_only') {
    base.memoryCache = { source: 'memory_cache', conversationCount: 0, conversations: [], selectedConversation: {} };
    base.reactFiber = { source: 'react_fiber', fiberNodeCount: 0, conversationLikeObjectCount: 0, conversations: [], selectedConversation: {} };
    base.domList = { source: 'dom_geometry', itemCount: 0, items: [] };
  }
  base.summary = buildSourcesSummary(base);
  return base;
}

async function runConversationSourcesInspectSession(options = {}) {
  const cfg = getDoudianConfig();
  const knownShops = cfg.knownShops || [];
  const bridgePort = Number(options.bridgePort || cfg.bridgePort || 19527);
  const installDir = options.installDir;
  const mockMode = Boolean(options.mockMode);
  const mockScenario = options.mockScenario || 'full';
  const timeoutMinutes = Number(options.timeoutMinutes || DEFAULT_TIMEOUT_MINUTES);
  const startedAt = Date.now();

  const report = {
    success: false,
    reason: '',
    imBridgeSeen: 0,
    activeShop: { shopId: '', shopName: '' },
    activeShopResolved: false,
    conversations: [],
    count: 0,
    selectedConversation: {},
    selectedConversationDetected: false,
    conversationListCaptured: false,
    sendAllowedBySelectedConversation: false,
    summary: {},
    sourcesInspection: null,
    warnings: [],
    errors: [],
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: '',
    durationMs: 0,
    timeoutMinutes,
    patchManifest: options.patchManifest || null,
    portGuard: options.portGuard || null,
    runLock: options.runLock || null,
  };

  if (mockMode) {
    const inspection = buildMockSourcesInspection(mockScenario);
    applyMergedSourcesToReport(report, inspection);
    report.success = true;
    report.reason = inspection.reason;
    report.imBridgeSeen = 1;
    report.activeShopResolved = true;
    report.activeShop = inspection.shopInfo;
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeSourcesInspectionReport(report);
  }

  const ctx = createImLiveContext({ knownShops, report });
  let inspected = false;

  ctx.handlers.push((envelope) => {
    if (envelope.type === DOUDIAN_EVENTS.CONVERSATION_SOURCES_INSPECTION) {
      applyMergedSourcesToReport(report, envelope.payload || {});
      report.success = true;
      report.reason = envelope.payload?.reason || 'conversation_sources_inspected';
      inspected = true;
    }
    if (envelope.type === DOUDIAN_EVENTS.CONVERSATION_LIST_CAPTURED && !inspected) {
      applyMergedSourcesToReport(report, envelope.payload || {});
      if (report.selectedConversationDetected || report.count > 0) {
        report.success = true;
        report.reason = envelope.payload?.reason || 'conversation_list_captured';
        inspected = true;
      }
    }
  });

  const boot = await bootstrapImLiveClient({
    installDir,
    bridgePort,
    report,
    ctx,
    logLabel: 'inspect-conversation-sources',
    timeoutMinutes,
  });

  if (!boot.ok) {
    report.reason = boot.reason || 'im_workspace_not_opened';
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeSourcesInspectionReport(report);
  }

  const { wsServer, child } = boot;
  report.imBridgeSeen = 1;
  console.log(`[抖店桥] 等待 IM 多源探测预热（${INSPECT_WARMUP_MS / 1000}s）...`);
  await sleep(INSPECT_WARMUP_MS);

  const logged = (report.loggedInShops || [])[0];
  if (!report.activeShop?.shopId && logged?.shopId) {
    report.activeShop = { shopId: logged.shopId, shopName: logged.shopName || '' };
    report.activeShopResolved = true;
  }

  const deadline = Date.now() + Math.min(INSPECT_TIMEOUT_MS, timeoutMinutes * 60 * 1000);
  let lastRequestAt = 0;

  while (!inspected && Date.now() < deadline) {
    ctx.applyShopStats();
    applyIntegrityWarningsToReport(report, ctx.integrityWarnings);
    const imBridgeIds = ctx.tracker.getImBridgeIds();
    if (Date.now() - lastRequestAt >= HINTS_INTERVAL_MS) {
      for (const id of imBridgeIds) {
        wsServer.sendDebugCommand(id, 'debug.inspect_conversation_sources', {});
      }
      lastRequestAt = Date.now();
    }
    await sleep(POLL_MS);
  }

  if (!inspected) {
    report.reason = report.reason || 'conversation_sources_timeout';
    report.success = Boolean(report.selectedConversationDetected || report.count > 0);
  }

  const terminal = formatConversationListTerminal(report.conversations || [], report.selectedConversation || {});
  for (const line of terminal) console.log(line);

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  try {
    child.unref();
  } catch {
    // ignore
  }
  return sanitizeSourcesInspectionReport(report);
}

function buildGuidedSourcesInspectTextReport(report) {
  const lines = [];
  lines.push('=== 抖店引导式会话来源诊断报告 ===');
  lines.push(`时间: ${report.finishedAt || new Date().toISOString()}`);
  lines.push(`结果: ${report.success ? '成功' : '失败'}`);
  lines.push(`reason: ${report.reason || ''}`);
  lines.push(`guidedMode: ${report.guidedMode || false}`);
  lines.push(`imBridgeSeen: ${report.imBridgeSeen || 0}`);
  lines.push(`activeShopResolved: ${report.activeShopResolved || false}`);
  lines.push(`activeShop: ${report.activeShop?.shopId || ''} / ${report.activeShop?.shopName || ''}`);
  lines.push(`selectedConversationDetected: ${report.selectedConversationDetected || false}`);
  lines.push(`buyerId: ${report.buyerId || ''}`);
  lines.push(`buyerName: ${report.buyerName || ''}`);
  lines.push(`conversationId: ${report.conversationId || ''}`);
  lines.push(`waitedForUserSelectionMs: ${report.waitedForUserSelectionMs || 0}`);
  lines.push(`emptyStateDetected: ${report.emptyStateDetected || false}`);
  lines.push(`emptyStateText: ${report.emptyStateText || ''}`);
  lines.push(`memoryCacheConversationCount: ${report.memoryCacheConversationCount || 0}`);
  lines.push(`reactFiberConversationLikeObjectCount: ${report.reactFiberConversationLikeObjectCount || 0}`);
  lines.push(`domListItemCount: ${report.domListItemCount || 0}`);
  if (report.warnings?.length) {
    lines.push('Warnings:');
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  if (report.errors?.length) {
    lines.push('Errors:');
    for (const e of report.errors) lines.push(`- ${e}`);
  }
  lines.push('');
  lines.push(...formatConversationListTerminal(report.conversations || [], report.selectedConversation || {}));
  return lines;
}

async function runMockGuidedInspectSession(report, options, startedAt) {
  const waitStarted = Date.now();
  await sleep(30);
  report.waitedForUserSelectionMs = Date.now() - waitStarted;

  if (options.mockScenario === 'timeout') {
    report.emptyStateDetected = true;
    report.emptyStateText = '您今日暂无接待数据';
    report.reason = 'timeout_no_selected_conversation';
    report.success = false;
    report.imBridgeSeen = 1;
    report.activeShopResolved = true;
    report.activeShop = { shopId: '263636465', shopName: 'XY祥钰珠宝' };
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeSourcesInspectionReport(report);
  }

  if (options.mockScenario === 'empty_then_wait') {
    report.emptyStateDetected = true;
    report.emptyStateText = '您今日暂无接待数据';
    report.selectedConversationDetected = false;
    report.reason = '';
    report.success = false;
    report.imBridgeSeen = 1;
    report.activeShopResolved = true;
    report.activeShop = { shopId: '263636465', shopName: 'XY祥钰珠宝' };
    report.mockGuidedSummary = { inspectedWhileEmpty: true, exitedEarly: false };
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeSourcesInspectionReport(report);
  }

  const inspection = buildMockSourcesInspection('full');
  applyMergedSourcesToReport(report, inspection);
  syncGuidedSourceCounts(report);
  applyEmptyStateFlags(report);
  report.success = true;
  report.reason = 'conversation_selected';
  report.imBridgeSeen = 1;
  report.activeShopResolved = true;
  report.activeShop = inspection.shopInfo;
  report.userSelectionDetectedAt = new Date().toISOString();
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  return sanitizeSourcesInspectionReport(report);
}

async function runConversationSourcesGuidedSession(options = {}) {
  const cfg = getDoudianConfig();
  const knownShops = cfg.knownShops || [];
  const bridgePort = Number(options.bridgePort || cfg.bridgePort || 19527);
  const installDir = options.installDir;
  const mockMode = Boolean(options.mockMode);
  const mockScenario = options.mockScenario || 'selected';
  const timeoutMinutes = Number(options.timeoutMinutes || GUIDED_DEFAULT_TIMEOUT_MINUTES);
  const startedAt = Date.now();
  const waitStartedAt = Date.now();

  const report = {
    success: false,
    reason: '',
    guidedMode: true,
    imBridgeSeen: 0,
    activeShop: { shopId: '', shopName: '' },
    activeShopResolved: false,
    buyerId: '',
    buyerName: '',
    conversationId: '',
    conversations: [],
    count: 0,
    selectedConversation: {},
    selectedConversationDetected: false,
    conversationListCaptured: false,
    sendAllowedBySelectedConversation: false,
    waitedForUserSelectionMs: 0,
    emptyStateDetected: false,
    emptyStateText: '',
    memoryCacheConversationCount: 0,
    reactFiberConversationLikeObjectCount: 0,
    domListItemCount: 0,
    summary: {},
    sourcesInspection: null,
    warnings: [],
    errors: [],
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: '',
    durationMs: 0,
    timeoutMinutes,
    patchManifest: options.patchManifest || null,
    portGuard: options.portGuard || null,
    runLock: options.runLock || null,
  };

  if (mockMode) {
    return runMockGuidedInspectSession(report, { mockScenario }, startedAt);
  }

  const ctx = createImLiveContext({ knownShops, report });
  let completed = false;

  ctx.handlers.push((envelope) => {
    if (
      envelope.type === DOUDIAN_EVENTS.CONVERSATION_SOURCES_INSPECTION ||
      envelope.type === DOUDIAN_EVENTS.CONVERSATION_LIST_CAPTURED
    ) {
      applyMergedSourcesToReport(report, envelope.payload || {});
      syncGuidedSourceCounts(report);
      applyEmptyStateFlags(report);
      const logged = (report.loggedInShops || [])[0];
      if (!report.activeShop?.shopId && logged?.shopId) {
        report.activeShop = { shopId: logged.shopId, shopName: logged.shopName || '' };
        report.shopId = logged.shopId;
        report.shopName = logged.shopName || '';
        report.activeShopResolved = true;
      }
      if (isGuidedConversationReady(report)) {
        completed = true;
        report.success = true;
        report.reason = 'conversation_selected';
        report.userSelectionDetectedAt = new Date().toISOString();
        report.waitedForUserSelectionMs = Date.now() - waitStartedAt;
      }
    }
  });

  const boot = await bootstrapImLiveClient({
    installDir,
    bridgePort,
    report,
    ctx,
    logLabel: 'inspect-conversation-sources-guided',
    timeoutMinutes,
  });

  if (!boot.ok) {
    report.reason = boot.reason || 'im_workspace_not_opened';
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    report.waitedForUserSelectionMs = Date.now() - waitStartedAt;
    return sanitizeSourcesInspectionReport(report);
  }

  const { wsServer, child } = boot;
  report.imBridgeSeen = 1;
  console.log('[抖店桥] guided 模式: IM 就绪后将持续等待您手动点开买家会话...');
  await sleep(INSPECT_WARMUP_MS);

  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  let lastRequestAt = 0;
  let lastBriefingAt = 0;

  while (!completed && Date.now() < deadline) {
    ctx.applyShopStats();
    applyIntegrityWarningsToReport(report, ctx.integrityWarnings);
    ctx.tracker.refreshShopStats();
    report.imBridgeSeen = Math.max(report.imBridgeSeen || 0, ctx.tracker.hasImBridge() ? 1 : 0);

    const imBridgeIds = ctx.tracker.getImBridgeIds();
    if (Date.now() - lastRequestAt >= GUIDED_POLL_MS) {
      for (const id of imBridgeIds) {
        wsServer.sendDebugCommand(id, 'debug.inspect_conversation_sources', {});
      }
      lastRequestAt = Date.now();
    }

    if (Date.now() - lastBriefingAt >= GUIDED_BRIEFING_MS) {
      printGuidedConversationBriefing(report, 'conversation guided');
      lastBriefingAt = Date.now();
    }

    await sleep(1000);
  }

  report.waitedForUserSelectionMs = Date.now() - waitStartedAt;
  if (!completed) {
    report.reason = 'timeout_no_selected_conversation';
    report.success = false;
    syncGuidedSourceCounts(report);
    applyEmptyStateFlags(report);
  } else {
    printGuidedConversationBriefing(report, 'conversation guided');
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  try {
    child.unref();
  } catch {
    // ignore
  }
  return sanitizeSourcesInspectionReport(report);
}

module.exports = {
  runConversationSourcesInspectSession,
  runConversationSourcesGuidedSession,
  buildSourcesInspectTextReport,
  buildGuidedSourcesInspectTextReport,
  buildMockSourcesInspection,
};
