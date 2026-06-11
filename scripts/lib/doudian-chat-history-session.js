const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { getDoudianWsServer } = require('../../src/platforms/doudian/doudian-ws-server');
const { DOUDIAN_EVENTS } = require('../../src/platforms/doudian/doudian-types');
const { getDoudianConfig } = require('../../src/shared/config');
const { DoudianDedupe } = require('../../src/platforms/doudian/doudian-dedupe');
const {
  insertMessage,
  insertCaptureCandidate,
  closeDb,
} = require('../../src/platforms/doudian/doudian-data-store');
const {
  parseChatHistoryPayload,
  extractLinkInfo,
  resolveApiName,
  createMockFixtures,
  buildMemoryHistoryCandidate,
  isHistoryMemoryCacheKey,
} = require('../../src/platforms/doudian/doudian-pigeon-parser');
const {
  toHistoryPlatformMessage,
  isHistoryMessageItem,
  countHistoryDirections,
  maskHistorySamples,
} = require('../../src/platforms/doudian/doudian-chat-history-utils');
const { maskMessageForReport, pickFirst } = require('../../src/platforms/doudian/doudian-shop-utils');
const { parseStdoutBusinessSignals, redactStdoutLine } = require('../../src/platforms/doudian/doudian-stdout-business-parser');
const {
  buildShopStatsSnapshot,
  applyShopStatsToTarget,
} = require('../../src/platforms/doudian/doudian-shop-stats-aggregator');
const {
  TEST_INSTALL_DIR,
  sleep,
} = require('./auto-verify-utils');
const { ShopBridgeTracker, LISTEN_WATCH_TYPES } = require('./shop-bridge-tracker');
const {
  runDoudianImWorkspacePhase,
  attachOpenImAttemptResponse,
  DEFAULT_IM_WAIT_MS,
} = require('../../src/platforms/doudian/doudian-im-workspace-ensurer');
const {
  scanStdoutLine,
  scanWindowTitle,
  applyIntegrityWarningsToReport,
} = require('../../src/platforms/doudian/doudian-integrity-warning-monitor');
const {
  evaluateConversationSelection,
  evaluateHistoryTrust,
  validateDoudianMessageBeforeInsert,
  getKnownShopIds,
  isValidTrustedBuyerName,
} = require('../../src/platforms/doudian/doudian-history-validation');
const {
  analyzeDomInspection,
  bubblesToHistoryItems,
} = require('../../src/platforms/doudian/doudian-chat-dom-trust');
const {
  resolveDirectionFromBubble,
  computeDirectionStats,
  DIRECTION_CONFIDENCE_THRESHOLD,
} = require('../../src/platforms/doudian/doudian-direction-resolver');
const {
  resolveConversationContext,
  mergeConversationFromMemoryCache,
  applyConversationUpdates,
  buildFallbackConversationId,
  resolveSelectedConversation,
  applySelectedConversationToReport,
  isConversationSelected,
} = require('../../src/platforms/doudian/doudian-conversation-resolver');

const BRIEFING_MS = 10000;
const HISTORY_READ_INTERVAL_MS = 15000;
const DEFAULT_TIMEOUT_MINUTES = 10;
const DEFAULT_GUIDED_TIMEOUT_MINUTES = 30;
const GUIDED_BRIEFING_MS = 5000;
const GUIDED_HINTS_INTERVAL_MS = 5000;

function applyBridgeClassificationToReport(report, tracker) {
  const counts =
    typeof tracker.getBridgeClassificationCounts === 'function'
      ? tracker.getBridgeClassificationCounts()
      : {
          homepageBridgeSeen: tracker.hasHomepageBridge?.() ? 1 : 0,
          emptyBridgeSeen: 0,
          rustWorkerBridgeSeen: 0,
          imBridgeSeen: tracker.hasImBridge?.() ? 1 : 0,
        };
  report.homepageBridgeSeen = counts.homepageBridgeSeen;
  report.emptyBridgeSeen = counts.emptyBridgeSeen;
  report.rustWorkerBridgeSeen = counts.rustWorkerBridgeSeen;
  report.imBridgeSeen = Math.max(report.imBridgeSeen ? 1 : 0, counts.imBridgeSeen);
  return report;
}

function parseTimeoutMinutes(argv = [], defaultMinutes = DEFAULT_TIMEOUT_MINUTES) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--timeout-minutes' && argv[i + 1]) {
      return Math.max(1, Number(argv[i + 1]) || defaultMinutes);
    }
  }
  return defaultMinutes;
}

function parseGuidedTimeoutMinutes(argv = []) {
  return parseTimeoutMinutes(argv, DEFAULT_GUIDED_TIMEOUT_MINUTES);
}

function isHistoryCacheCandidate(payload = {}) {
  const key = String(payload.cacheKey || payload.url || payload.urlPath || '');
  const apiName = String(payload.apiName || resolveApiName(key)).toLowerCase();
  return isHistoryMemoryCacheKey(key) || isHistoryMemoryCacheKey(apiName);
}

function isValidBuyerName(name) {
  return isValidTrustedBuyerName(name);
}

function getActiveShopContext(report) {
  const shop = (report.activeImShops || [])[0] || {};
  return {
    shopId: pickFirst(shop.shopId),
    shopName: pickFirst(shop.shopName),
  };
}

function trackRejectReason(report, reason) {
  if (!reason) return;
  if (!report.rejectReasons.includes(reason)) report.rejectReasons.push(reason);
}

function updateConversationSelection(report, fields = {}) {
  const evalResult = evaluateConversationSelection(fields);
  if (evalResult.uiNoiseBuyerNameDetected) {
    report.uiNoiseBuyerNameDetected = true;
    report.conversationTrusted = false;
    report.buyerNameTrusted = false;
    if (evalResult.reason) trackRejectReason(report, evalResult.reason);
    return;
  }

  const conversationId = pickFirst(fields.conversationId);
  const buyerId = pickFirst(fields.buyerId);
  const buyerName = pickFirst(fields.buyerName);

  if (conversationId && !/^doudian:/.test(conversationId)) {
    report.conversationId = conversationId;
    report.conversationIdSource = pickFirst(fields.conversationIdSource, report.conversationIdSource, 'selected_conversation');
    report.fallbackConversationIdUsed = false;
  }
  if (buyerId) report.buyerId = buyerId;
  if (isValidBuyerName(buyerName)) {
    report.buyerName = buyerName;
    report.buyerNameSource = pickFirst(fields.buyerNameSource, 'selected_conversation');
    report.buyerNameTrusted = true;
  }

  report.selectedConversationDetected = evalResult.selectedConversationDetected;
  report.conversationTrusted = evalResult.conversationTrusted;
}

function enrichSampleMessage(normalized, convMeta = {}) {
  return maskHistorySamples(
    [
      {
        ...normalized,
        conversationIdSource: pickFirst(normalized.conversationIdSource, convMeta.conversationIdSource),
      },
    ],
    1
  )[0];
}

function buildHistoryTextReport(report) {
  const lines = [];
  lines.push('=== 抖店聊天历史验证报告 ===');
  lines.push(`时间: ${report.finishedAt || new Date().toISOString()}`);
  lines.push(`结果: ${report.success ? '成功' : '失败/等待结束'}`);
  lines.push(`reason: ${report.reason || ''}`);
  lines.push(`isMock: ${report.isMock || false}`);
  lines.push(`timeoutMinutes: ${report.timeoutMinutes}`);
  lines.push(`durationMs: ${report.durationMs}`);
  lines.push(`imBridgeSeen: ${report.imBridgeSeen}`);
  lines.push(`imOpenAttempted: ${report.imOpenAttempted}`);
  lines.push(`imOpenSuccess: ${report.imOpenSuccess}`);
  lines.push(`imWorkspaceWaitMs: ${report.imWorkspaceWaitMs ?? 0}`);
  lines.push(`imWorkspaceReason: ${report.imWorkspaceReason || ''}`);
  lines.push(`homepageBridgeSeen: ${report.homepageBridgeSeen ?? 0}`);
  lines.push(`emptyBridgeSeen: ${report.emptyBridgeSeen ?? 0}`);
  lines.push(`rustWorkerBridgeSeen: ${report.rustWorkerBridgeSeen ?? 0}`);
  lines.push(`activeImShopCount: ${report.activeImShopCount ?? report.activeImShops?.length ?? 0}`);
  lines.push(`shopReportValid: ${report.shopReportValid ?? ''}`);
  lines.push(`selectedConversationDetected: ${report.selectedConversationDetected}`);
  lines.push(`conversationTrusted: ${report.conversationTrusted ?? ''}`);
  lines.push(`historyTrusted: ${report.historyTrusted ?? ''}`);
  lines.push(`validatedMessageCount: ${report.validatedMessageCount ?? 0}`);
  lines.push(`candidateOnlyCount: ${report.candidateOnlyCount ?? 0}`);
  lines.push(`insertBlockedCount: ${report.insertBlockedCount ?? 0}`);
  lines.push(`wrongShopCandidateCount: ${report.wrongShopCandidateCount ?? 0}`);
  lines.push(`uiNoiseBuyerNameDetected: ${report.uiNoiseBuyerNameDetected ?? false}`);
  lines.push(`chatBubbleCandidateCount: ${report.chatBubbleCandidateCount ?? 0}`);
  lines.push(`sidePanelCandidateCount: ${report.sidePanelCandidateCount ?? 0}`);
  lines.push(`domInspectionCount: ${report.domInspectionCount ?? 0}`);
  lines.push(`candidateMessageAreaCount: ${report.candidateMessageAreaCount ?? 0}`);
  lines.push(`candidateBubbleCount: ${report.candidateBubbleCount ?? 0}`);
  lines.push(`trustedMessageAreaCount: ${report.trustedMessageAreaCount ?? 0}`);
  lines.push(`trustedBubbleCount: ${report.trustedBubbleCount ?? 0}`);
  lines.push(`memoryHistoryCandidateCount: ${report.memoryHistoryCandidateCount ?? 0}`);
  lines.push(`conversationIdSource: ${report.conversationIdSource || ''}`);
  lines.push(`buyerNameSource: ${report.buyerNameSource || ''}`);
  lines.push(`buyerNameTrusted: ${report.buyerNameTrusted ?? false}`);
  lines.push(`fallbackConversationIdUsed: ${report.fallbackConversationIdUsed ?? false}`);
  lines.push(`directionRejectedCount: ${report.directionRejectedCount ?? 0}`);
  lines.push(`directionRecoveredCount: ${report.directionRecoveredCount ?? 0}`);
  lines.push(`directionConfidenceAvg: ${report.directionConfidenceAvg ?? 0}`);
  lines.push(
    `directionStats: buyer=${report.directionStats?.buyer ?? 0} seller=${report.directionStats?.seller ?? 0} unknown=${report.directionStats?.unknown ?? 0}`
  );
  if (report.historyFailureDetail) lines.push(`historyFailureDetail: ${report.historyFailureDetail}`);
  lines.push(`conversationId: ${report.conversationId ? `${String(report.conversationId).slice(0, 8)}***` : ''}`);
  lines.push(`buyerId: ${report.buyerId ? `${String(report.buyerId).slice(0, 4)}***` : ''}`);
  lines.push(`buyerName: ${report.buyerName || ''}`);
  lines.push(`historyMessageCount: ${report.historyMessageCount}`);
  lines.push(`realBuyerMessageCount: ${report.realBuyerMessageCount}`);
  lines.push(`sellerMessageCount: ${report.sellerMessageCount}`);
  lines.push(`insertedMessageCount: ${report.insertedMessageCount}`);
  lines.push(`dedupeHitCount: ${report.dedupeHitCount}`);
  lines.push(
    `sources: memoryCache=${report.sources?.memoryCache ?? 0} dom=${report.sources?.dom ?? 0} ipc=${report.sources?.ipc ?? 0}`
  );
  if (report.sampleMessages?.length) {
    lines.push('');
    lines.push('Sample messages:');
    for (const m of report.sampleMessages) lines.push(`- ${JSON.stringify(m)}`);
  }
  if (report.rejectReasons?.length) {
    lines.push('');
    lines.push('Reject reasons:');
    for (const r of report.rejectReasons) lines.push(`- ${r}`);
  }
  if (report.warnings?.length) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  if (report.errors?.length) {
    lines.push('');
    lines.push('Errors:');
    for (const e of report.errors) lines.push(`- ${e}`);
  }
  if (report.nextActions?.length) {
    lines.push('');
    lines.push('Next actions:');
    for (const a of report.nextActions) lines.push(`- ${a}`);
  }
  return lines;
}

function getActiveShopLabel(report) {
  const shop = (report.activeImShops || [])[0];
  if (!shop) return '-';
  return `${shop.shopId || ''} / ${shop.shopName || ''}`.trim();
}

function getHistoryStatus(report) {
  if (!report.selectedConversationDetected) {
    return '等待用户打开买家会话';
  }
  if (!report.historyTrusted) return '正在读取并校验历史消息';
  return '历史消息已捕获';
}

function getGuidedHistoryStatus(report) {
  if (!report.selectedConversationDetected) {
    return '请在抖店聊天窗口手动点开一个有历史消息的买家会话';
  }
  if (!report.historyTrusted) return '正在读取并校验历史消息';
  return '历史消息已捕获';
}

function printGuidedBriefing(report) {
  console.log('[抖店桥] guided history:');
  console.log(`IM已打开: ${(report.imBridgeSeen || 0) >= 1}`);
  console.log(`activeShop: ${getActiveShopLabel(report)}`);
  console.log(`selectedConversationDetected: ${report.selectedConversationDetected}`);
  console.log(`buyerId: ${report.buyerId ? `${String(report.buyerId).slice(0, 4)}***` : ''}`);
  console.log(`buyerName: ${report.buyerName || ''}`);
  console.log(
    `conversationId: ${
      report.conversationId
        ? report.fallbackConversationIdUsed
          ? `${String(report.conversationId).slice(0, 16)}*** / fallback_buyerId`
          : `${String(report.conversationId).slice(0, 8)}***`
        : ''
    }`
  );
  console.log(`状态: ${getGuidedHistoryStatus(report)}`);
}

function buildGuidedHistoryTextReport(report) {
  const lines = buildHistoryTextReport(report);
  lines.splice(4, 0, `guidedMode: ${report.guidedMode || false}`);
  if (report.waitedForUserSelectionMs != null) {
    lines.push(`waitedForUserSelectionMs: ${report.waitedForUserSelectionMs}`);
  }
  if (report.userSelectionDetectedAt) {
    lines.push(`userSelectionDetectedAt: ${report.userSelectionDetectedAt}`);
  }
  if (report.activeShop?.shopId) {
    lines.push(`activeShop: ${report.activeShop.shopId} / ${report.activeShop.shopName || ''}`);
  }
  return lines;
}

async function runChatHistorySession(options = {}) {
  const cfg = getDoudianConfig();
  const knownShops = cfg.knownShops || [];
  const bridgePort = Number(options.bridgePort || cfg.bridgePort || 19527);
  const installDir = options.installDir || TEST_INSTALL_DIR;
  const exePath = path.join(installDir, 'doudian.exe');
  const guidedMode = Boolean(options.guidedMode);
  const mockGuidedMode = Boolean(options.mockGuidedMode);
  const defaultTimeout = guidedMode ? DEFAULT_GUIDED_TIMEOUT_MINUTES : DEFAULT_TIMEOUT_MINUTES;
  const timeoutMinutes = Number(options.timeoutMinutes || defaultTimeout);
  const dbPath = options.dbPath || path.join(process.cwd(), 'logs', 'doudian-chat-history.db');
  const mockMode = Boolean(options.mockMode);

  const startedAt = Date.now();
  const report = {
    success: false,
    reason: '',
    isMock: mockMode,
    guidedMode,
    timeoutMinutes,
    durationMs: 0,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: '',
    imBridgeSeen: 0,
    imOpenAttempted: false,
    imOpenAttempts: [],
    imOpenSuccess: false,
    imWorkspaceWaitMs: 0,
    imWorkspaceReason: '',
    homepageBridgeSeen: 0,
    emptyBridgeSeen: 0,
    rustWorkerBridgeSeen: 0,
    integrityWarningDetected: false,
    integrityWarnings: [],
    patchManifest: options.patchManifest || null,
    portGuard: options.portGuard || null,
    runLock: options.runLock || null,
    loggedInShopCount: 0,
    activeImShopCount: 0,
    inactiveShopCount: 0,
    loggedInShops: [],
    activeImShops: [],
    inactiveShops: [],
    unknownImBridgeCount: 0,
    shopReportValid: undefined,
    selectedConversationDetected: false,
    conversationId: '',
    buyerId: '',
    buyerName: '',
    historyMessageCount: 0,
    realBuyerMessageCount: 0,
    sellerMessageCount: 0,
    insertedMessageCount: 0,
    dedupeHitCount: 0,
    sources: { memoryCache: 0, dom: 0, ipc: 0 },
    sampleMessages: [],
    conversationTrusted: false,
    historyTrusted: false,
    insertBlockedCount: 0,
    candidateOnlyCount: 0,
    rejectReasons: [],
    wrongShopCandidateCount: 0,
    uiNoiseBuyerNameDetected: false,
    sidePanelCandidateCount: 0,
    chatBubbleCandidateCount: 0,
    validatedMessageCount: 0,
    domAreas: null,
    domInspectionCount: 0,
    candidateMessageAreaCount: 0,
    candidateBubbleCount: 0,
    trustedMessageAreaCount: 0,
    trustedBubbleCount: 0,
    memoryHistoryCandidateCount: 0,
    bestMessageArea: null,
    bestBubbleSamples: [],
    domInspectionSummary: {},
    historyFailureDetail: '',
    directionStats: { buyer: 0, seller: 0, unknown: 0 },
    directionConfidenceAvg: 0,
    conversationIdSource: '',
    buyerNameSource: '',
    buyerNameTrusted: false,
    fallbackConversationIdUsed: false,
    directionRejectedCount: 0,
    directionRecoveredCount: 0,
    activeShop: { shopId: '', shopName: '' },
    waitedForUserSelectionMs: 0,
    userSelectionDetectedAt: '',
    warnings: [],
    errors: [],
    nextActions: [],
  };

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  closeDb();
  process.env.DOUDIAN_VERIFY_DB = dbPath;

  const knownShopIds = getKnownShopIds(knownShops);
  const dedupe = new DoudianDedupe();
  const tracker = new ShopBridgeTracker({ knownShops });
  const shopIdentityHints = [];
  const memoryCacheHints = [];
  const historyKeys = new Set();
  let stdoutLines = [];
  let captured = false;
  let lastBriefingAt = 0;
  let lastHistoryReadAt = 0;
  let lastDomInspectAt = 0;
  let lastConversationHintsAt = 0;
  let latestDomHints = {};
  let latestMemoryHints = {};
  let selectionAnnounced = false;
  let pendingImmediateHistoryRead = false;
  let historyWaitStarted = 0;

  function refreshConversationSelectionFromHints() {
    const activeShop = getActiveShopContext(report);
    const resolved = resolveSelectedConversation(
      report,
      { domHints: latestDomHints, memoryHints: latestMemoryHints },
      activeShop
    );
    applySelectedConversationToReport(report, resolved, activeShop);
    return resolved;
  }

  function announceGuidedSelection(resolved = {}) {
    if (!guidedMode || selectionAnnounced || !isConversationSelected(resolved)) return;
    selectionAnnounced = true;
    report.userSelectionDetectedAt = new Date().toISOString();
    report.waitedForUserSelectionMs = historyWaitStarted
      ? Date.now() - historyWaitStarted
      : 0;
    console.log('[抖店桥] 已检测到买家会话');
    console.log(`buyerId: ${report.buyerId ? `${String(report.buyerId).slice(0, 4)}***` : ''}`);
    console.log(`buyerName: ${report.buyerName || ''}`);
    console.log(
      `conversationId: ${
        report.conversationId
          ? report.fallbackConversationIdUsed
            ? `${String(report.conversationId).slice(0, 16)}*** / fallback_buyerId`
            : `${String(report.conversationId).slice(0, 8)}***`
          : ''
      }`
    );
    console.log('开始读取历史消息...');
    pendingImmediateHistoryRead = true;
  }

  function applyDomInspectionAnalysis(payload = {}) {
    const analysis = analyzeDomInspection(payload);
    report.domInspectionCount += 1;
    report.candidateMessageAreaCount = Math.max(
      report.candidateMessageAreaCount || 0,
      analysis.candidateMessageAreaCount
    );
    report.candidateBubbleCount = Math.max(report.candidateBubbleCount || 0, analysis.candidateBubbleCount);
    report.trustedMessageAreaCount = Math.max(
      report.trustedMessageAreaCount || 0,
      analysis.trustedMessageAreaCount
    );
    report.trustedBubbleCount = Math.max(report.trustedBubbleCount || 0, analysis.trustedBubbleCount);
    if (analysis.bestMessageArea && (!report.bestMessageArea || (analysis.bestMessageArea.score || 0) > (report.bestMessageArea.score || 0))) {
      report.bestMessageArea = analysis.bestMessageArea;
    }
    if (analysis.bestBubbleSamples?.length) {
      report.bestBubbleSamples = analysis.bestBubbleSamples;
    }
    report.domInspectionSummary = {
      ...(report.domInspectionSummary || {}),
      ...analysis.domInspectionSummary,
      lastInspectionAt: new Date().toISOString(),
    };
    return analysis;
  }

  function recordUntrustedDomItems(items, shopInfo, meta = {}) {
    for (const item of items) {
      if (item.trusted) continue;
      report.candidateOnlyCount += 1;
      trackRejectReason(report, 'chat_bubble_area_not_trusted');
      insertCaptureCandidate({
        platform: 'doudian',
        captureType: 'history_rejected',
        isUiNoise: true,
        shopId: shopInfo.shopId || '',
        shopName: shopInfo.shopName || '',
        conversationId: meta.conversationId || report.conversationId || '',
        buyerId: meta.buyerId || report.buyerId || '',
        text: item.text || '',
        source: 'dom',
        bridgeId: meta.bridgeId || '',
        pageHref: meta.pageHref || '',
        rejectReason: 'chat_bubble_area_not_trusted',
        raw: { direction: item.direction, domScore: item.domScore, selectorPath: item.selectorPath },
      });
    }
  }

  function applyShopStats(stdoutSignal) {
    const prevImBridgeSeen = report.imBridgeSeen || 0;
    const snapshot = buildShopStatsSnapshot({
      tracker,
      stdoutSignal,
      knownShops,
      shopIdentityHints,
      memoryCacheHints,
    });
    applyShopStatsToTarget(report, snapshot);
    report.imBridgeSeen = Math.max(prevImBridgeSeen, report.imBridgeSeen || 0);
  }

  function bumpSource(source) {
    if (source === 'memory_cache') report.sources.memoryCache += 1;
    else if (source === 'dom') report.sources.dom += 1;
    else if (source === 'ipc') report.sources.ipc += 1;
  }

  function refreshDirectionCounts() {
    const validatedSamples = report.sampleMessages.map((m) => ({
      direction: m.direction,
      directionConfidence: m.directionConfidence,
    }));
    const counts = countHistoryDirections(validatedSamples);
    report.realBuyerMessageCount = counts.realBuyerMessageCount;
    report.sellerMessageCount = counts.sellerMessageCount;
    const stats = computeDirectionStats(validatedSamples);
    report.directionStats = stats.directionStats;
    report.directionConfidenceAvg = stats.directionConfidenceAvg;
  }

  function applyResolvedConversation(convMeta = {}) {
    const activeShop = getActiveShopContext(report);
    const resolved = resolveConversationContext(report, convMeta, activeShop);
    if (resolved.conversationId) {
      report.conversationId = resolved.conversationId;
      report.conversationIdSource = resolved.conversationIdSource || report.conversationIdSource;
      report.fallbackConversationIdUsed = Boolean(resolved.fallbackConversationIdUsed);
    }
    if (resolved.buyerId) report.buyerId = resolved.buyerId;
    if (resolved.buyerNameTrusted) {
      report.buyerName = resolved.buyerName;
      report.buyerNameSource = resolved.buyerNameSource;
      report.buyerNameTrusted = true;
    }
    return resolved;
  }

  function buildValidationContext(convMeta = {}) {
    const activeShop = getActiveShopContext(report);
    const resolved = applyResolvedConversation(convMeta);
    return {
      activeShopId: activeShop.shopId,
      activeShopName: activeShop.shopName,
      knownShopIds,
      knownShops,
      conversationId: pickFirst(resolved.conversationId, convMeta.conversationId, report.conversationId),
      buyerId: pickFirst(resolved.buyerId, convMeta.buyerId, report.buyerId),
      buyerName: pickFirst(resolved.buyerName, convMeta.buyerName, report.buyerName),
      conversationIdSource: pickFirst(resolved.conversationIdSource, convMeta.conversationIdSource),
      domArea: convMeta.domArea || 'chatBubbleArea',
      messageAreaTrusted: convMeta.messageAreaTrusted !== false,
      bubbleTrusted: convMeta.bubbleTrusted !== false,
    };
  }

  function rejectMessage(normalized, validation, convMeta = {}) {
    report.insertBlockedCount += 1;
    report.candidateOnlyCount += 1;
    trackRejectReason(report, validation.rejectReason);
    if (validation.rejectReason === 'unknown_direction_without_identity') {
      report.directionRejectedCount += 1;
    }
    if (validation.rejectReason === 'shop_id_not_active_shop' || validation.rejectReason === 'shop_id_not_in_known_shops') {
      report.wrongShopCandidateCount += 1;
    }
    if (convMeta.domArea && convMeta.domArea !== 'chatBubbleArea') {
      report.sidePanelCandidateCount += 1;
    }
    insertCaptureCandidate({
      platform: 'doudian',
      captureType: 'history_rejected',
      isUiNoise: validation.rejectReason === 'history_ui_noise_text',
      isRealMessageCandidate: false,
      shopId: normalized.shopId || '',
      shopName: normalized.shopName || '',
      conversationId: normalized.conversationId || '',
      buyerId: normalized.buyerId || '',
      messageId: normalized.messageId || '',
      text: normalized.text || '',
      source: normalized.source || convMeta.source || '',
      bridgeId: normalized.bridgeId || '',
      pageHref: normalized.pageHref || '',
      rejectReason: validation.rejectReason,
      raw: {
        direction: normalized.direction,
        messageType: normalized.messageType,
        domArea: convMeta.domArea || '',
        cardShopName: convMeta.cardShopName || '',
        checks: validation.checks,
      },
    });
  }

  function tryFinishSuccess() {
    if (captured) return;
    const trust = evaluateHistoryTrust({
      ...report,
      shopReportValid: report.shopReportValid !== false,
    });
    report.conversationTrusted = trust.conversationTrusted;
    report.historyTrusted = trust.historyTrusted;
    if (trust.historyTrusted) {
      captured = true;
      report.success = true;
      report.reason = trust.reason;
    } else if (trust.reason === 'history_direction_not_resolved') {
      report.reason = trust.reason;
    }
  }

  function finalizeGuidedOutcome() {
    const trust = evaluateHistoryTrust({
      ...report,
      shopReportValid: report.shopReportValid !== false,
    });
    report.conversationTrusted = trust.conversationTrusted;
    report.historyTrusted = trust.historyTrusted;

    if (captured) {
      report.success = true;
      report.reason = 'chat_history_captured';
      return;
    }

    if (!report.selectedConversationDetected) {
      report.success = false;
      report.reason = 'timeout_no_selected_conversation';
      report.nextActions = [
        '请在 IM 工作台手动点击一个有历史记录的真实买家会话后重试',
        '延长等待: npm run doudian:verify-chat-history-guided -- --timeout-minutes 60',
      ];
      return;
    }

    if (trust.reason === 'history_direction_not_resolved') {
      report.success = false;
      report.reason = trust.reason;
      return;
    }

    if (Number(report.historyMessageCount || 0) > 0 && !trust.historyTrusted) {
      report.success = false;
      report.reason = 'history_candidates_untrusted';
      report.warnings.push('捕获到历史候选，但未通过信任校验，已拒绝写入 platform_messages');
      return;
    }

    if (!trust.historyTrusted) {
      report.success = false;
      report.reason = 'history_message_not_found';
    }
  }

  function finalizeHistoryOutcome() {
    if (guidedMode) {
      finalizeGuidedOutcome();
      return;
    }

    const trust = evaluateHistoryTrust({
      ...report,
      shopReportValid: report.shopReportValid !== false,
    });
    report.conversationTrusted = trust.conversationTrusted;
    report.historyTrusted = trust.historyTrusted;

    if (captured) return;
    if (Number(report.wrongShopCandidateCount || 0) > 0) {
      report.reason = 'history_candidates_wrong_shop';
      return;
    }
    if (trust.reason === 'history_direction_not_resolved') {
      report.reason = trust.reason;
      return;
    }
    if (Number(report.historyMessageCount || 0) > 0 && !trust.historyTrusted) {
      report.reason = 'history_candidates_untrusted';
      return;
    }
    if (!report.selectedConversationDetected) {
      report.reason = report.uiNoiseBuyerNameDetected
        ? 'selected_conversation_name_is_ui_noise'
        : 'no_selected_conversation';
      return;
    }
    if (Number(report.historyMessageCount || 0) === 0) {
      report.reason = 'history_message_not_found';
      if (report.selectedConversationDetected) {
        if ((report.trustedBubbleCount || 0) === 0 && (report.memoryHistoryCandidateCount || 0) === 0) {
          report.historyFailureDetail =
            'selected conversation detected, but no trusted chat bubble area matched';
        } else if ((report.candidateBubbleCount || 0) > 0 && (report.trustedBubbleCount || 0) === 0) {
          report.historyFailureDetail =
            'candidate bubbles found but none passed trust scoring';
        } else {
          report.historyFailureDetail = 'no history messages from dom or memory cache';
        }
      }
      return;
    }
    report.reason = 'history_message_not_found';
  }

  function ingestHistoryItems(items, shopInfo, meta = {}) {
    if (!Array.isArray(items) || !items.length) return 0;
    let added = 0;

    const activeShop = getActiveShopContext(report);
    const resolvedShopInfo = {
      shopId: pickFirst(activeShop.shopId, shopInfo.shopId),
      shopName: pickFirst(activeShop.shopName, shopInfo.shopName),
      sessionPartitionKey: pickFirst(shopInfo.sessionPartitionKey),
      accountId: pickFirst(shopInfo.accountId),
    };

    const convMeta = {
      conversationId: pickFirst(meta.conversationId, report.conversationId),
      buyerId: pickFirst(meta.buyerId, report.buyerId),
      buyerName: pickFirst(meta.buyerName, report.buyerName),
      source: meta.source || 'memory_cache',
      bridgeId: meta.bridgeId || '',
      pageHref: meta.pageHref || '',
      domArea: meta.domArea || (meta.source === 'dom' ? 'chatBubbleArea' : ''),
    };

    updateConversationSelection(report, convMeta);
    const validationContext = buildValidationContext(convMeta);

    for (const item of items) {
      if (!isHistoryMessageItem(item)) continue;

      let workingItem = { ...item };
      if (meta.source === 'dom' && workingItem.directionConfidence == null) {
        const dirResolved = resolveDirectionFromBubble(workingItem, {
          messageAreaCenterX: report.bestMessageArea?.rect
            ? (report.bestMessageArea.rect.x || 0) + (report.bestMessageArea.rect.width || 0) / 2
            : 0,
        });
        workingItem = {
          ...workingItem,
          direction: dirResolved.direction,
          directionConfidence: dirResolved.directionConfidence,
          directionReasons: dirResolved.directionReasons,
        };
      }

      const normalized = toHistoryPlatformMessage(workingItem, resolvedShopInfo, {
        ...convMeta,
        conversationId: validationContext.conversationId,
        buyerId: validationContext.buyerId,
        buyerName: validationContext.buyerName,
        conversationIdSource: validationContext.conversationIdSource,
      });
      if (meta.source === 'dom') {
        normalized.shopId = resolvedShopInfo.shopId;
        normalized.shopName = resolvedShopInfo.shopName;
        normalized.domArea = workingItem.domArea || convMeta.domArea || 'chatBubbleArea';
        normalized.directionConfidence = workingItem.directionConfidence || normalized.directionConfidence || 0;
        normalized.directionReasons = workingItem.directionReasons || normalized.directionReasons || [];
        normalized.conversationId = pickFirst(normalized.conversationId, validationContext.conversationId);
        normalized.buyerId = pickFirst(normalized.buyerId, validationContext.buyerId);
        normalized.conversationIdSource = pickFirst(
          normalized.conversationIdSource,
          validationContext.conversationIdSource
        );
      }

      const key =
        normalized.messageId ||
        `${normalized.conversationId}:${normalized.direction}:${normalized.rawTextHash}:${normalized.timestamp}:${normalized.domArea || ''}`;
      if (historyKeys.has(key)) continue;
      historyKeys.add(key);
      report.historyMessageCount += 1;
      bumpSource(convMeta.source);

      const validation = validateDoudianMessageBeforeInsert(normalized, {
        ...validationContext,
        domArea: normalized.domArea || validationContext.domArea,
        messageAreaTrusted: workingItem.messageAreaTrusted !== false,
        bubbleTrusted: workingItem.bubbleTrusted !== false,
      });

      if (!validation.ok) {
        rejectMessage(normalized, validation, {
          ...convMeta,
          domArea: normalized.domArea,
          cardShopName: item.cardShopName || shopInfo.shopName,
        });
        continue;
      }

      if (
        (workingItem.direction === 'unknown' || !workingItem.direction) &&
        (normalized.direction === 'buyer' || normalized.direction === 'seller') &&
        Number(normalized.directionConfidence || 0) >= DIRECTION_CONFIDENCE_THRESHOLD
      ) {
        report.directionRecoveredCount += 1;
      }

      report.validatedMessageCount += 1;
      if (normalized.domArea === 'chatBubbleArea' || meta.source !== 'dom') {
        report.chatBubbleCandidateCount += 1;
      }

      if (report.sampleMessages.length < 10) {
        report.sampleMessages.push(enrichSampleMessage(normalized, validationContext));
      }

      const isDup = dedupe.isDuplicate(normalized);
      if (isDup) {
        report.dedupeHitCount += 1;
      } else {
        insertMessage(normalized);
        report.insertedMessageCount += 1;
        added += 1;
      }
    }

    refreshDirectionCounts();
    tryFinishSuccess();
    return added;
  }

  function processMemoryCacheCandidate(envelope) {
    const p = envelope.payload || {};
    if (!isHistoryCacheCandidate(p)) return;

    const shopInfo = {
      shopId: pickFirst(getActiveShopContext(report).shopId, p.shopId, p.shopInfo?.shopId),
      shopName: pickFirst(getActiveShopContext(report).shopName, p.shopName, p.shopInfo?.shopName),
      sessionPartitionKey: pickFirst(p.sessionPartitionKey, p.shopInfo?.sessionPartitionKey),
      accountId: pickFirst(p.accountId, p.shopInfo?.accountId),
    };

    const payload = p.payload || p.data || p.sample || p.body;
    const cacheKey = p.cacheKey || p.url || '';
    const apiName = p.apiName || resolveApiName(cacheKey);

    if (apiName === 'get_link_info' || /get_link_info/i.test(cacheKey)) {
      const link = extractLinkInfo(payload);
      updateConversationSelection(report, {
        ...link,
        conversationIdSource: 'memory_cache_get_link_info',
        buyerNameSource: 'memory_cache_get_link_info',
      });
    }

    const cacheUpdates = mergeConversationFromMemoryCache(report, payload, apiName || cacheKey);
    if (Object.keys(cacheUpdates).length) {
      latestMemoryHints = { ...latestMemoryHints, ...cacheUpdates };
      applyConversationUpdates(report, cacheUpdates);
      const resolved = refreshConversationSelectionFromHints();
      announceGuidedSelection(resolved);
    }

    const candidate = buildMemoryHistoryCandidate(payload, shopInfo, {
      cacheKey,
      url: cacheKey,
      apiName,
      conversationId: report.conversationId,
      buyerId: report.buyerId,
      buyerName: report.buyerName,
    });

    if (candidate) {
      processHistoryCandidate(envelope, candidate);
    }
  }

  function processHistoryCandidate(envelope, candidate = {}) {
    if (!candidate || !Array.isArray(candidate.items)) return;
    report.memoryHistoryCandidateCount += 1;

    if (candidate.conversationId || candidate.buyerId || candidate.buyerName) {
      updateConversationSelection(report, candidate);
    }

    if (candidate.items.length > 0) {
      ingestHistoryItems(candidate.items, candidate.shopInfo || getActiveShopContext(report), {
        source: candidate.source || 'memory_cache',
        bridgeId: envelope.bridgeId,
        conversationId: candidate.conversationId,
        buyerId: candidate.buyerId,
        buyerName: candidate.buyerName,
      });
    }
  }

  function processDomInspection(envelope) {
    const p = envelope.payload || {};
    applyDomInspectionAnalysis(p);

    if (p.selectedConversation) {
      latestDomHints = { ...latestDomHints, ...p.selectedConversation };
      const resolved = refreshConversationSelectionFromHints();
      announceGuidedSelection(resolved);
    }
  }

  function processHistorySnapshot(envelope) {
    const p = envelope.payload || {};

    if (p.domInspection) {
      applyDomInspectionAnalysis({
        candidateMessageAreas: p.domInspection.bestMessageArea ? [p.domInspection.bestMessageArea] : [],
        candidateBubbles: p.domInspection.bestBubbleSamples || [],
        scrollContainers: [],
        excludedAreas: [],
        textSamples: [],
      });
      report.trustedMessageAreaCount = Math.max(
        report.trustedMessageAreaCount || 0,
        p.domInspection.trustedMessageAreaCount || 0
      );
      report.trustedBubbleCount = Math.max(
        report.trustedBubbleCount || 0,
        p.domInspection.trustedBubbleCount || 0
      );
      if (p.domInspection.bestMessageArea) report.bestMessageArea = p.domInspection.bestMessageArea;
      if (p.domInspection.bestBubbleSamples?.length) {
        report.bestBubbleSamples = p.domInspection.bestBubbleSamples.map((m) =>
          maskMessageForReport(typeof m === 'string' ? { text: m, source: 'dom' } : m)
        );
      }
    }

    if (p.conversationId || p.buyerId || p.buyerName) {
      latestDomHints = {
        ...latestDomHints,
        conversationId: pickFirst(p.conversationId, latestDomHints.conversationId),
        buyerId: pickFirst(p.buyerId, latestDomHints.buyerId),
        buyerName: pickFirst(p.buyerName, latestDomHints.buyerName),
        buyerNameSource: pickFirst(p.buyerNameSource, latestDomHints.buyerNameSource),
        buyerIdSource: pickFirst(p.buyerIdSource, latestDomHints.buyerIdSource),
      };
      const resolved = refreshConversationSelectionFromHints();
      announceGuidedSelection(resolved);
    }

    const items = Array.isArray(p.items) ? p.items : [];
    const trustedItems = items.filter((it) => it.trusted !== false);
    const untrustedItems = items.filter((it) => it.trusted === false);

    if (untrustedItems.length) {
      recordUntrustedDomItems(untrustedItems, getActiveShopContext(report), {
        bridgeId: envelope.bridgeId,
        pageHref: p.href || p.pageHref || '',
        conversationId: p.conversationId,
        buyerId: p.buyerId,
        buyerName: p.buyerName,
      });
    }

    if (trustedItems.length > 0) {
      ingestHistoryItems(trustedItems, getActiveShopContext(report), {
        source: p.source || 'dom',
        bridgeId: envelope.bridgeId,
        pageHref: p.href || p.pageHref || '',
        conversationId: p.conversationId,
        buyerId: p.buyerId,
        buyerName: p.buyerName,
      });
    } else if (items.length === 0 && report.candidateBubbleCount > 0 && report.trustedBubbleCount === 0) {
      trackRejectReason(report, 'chat_bubble_area_not_trusted');
    }
  }

  let integrityWarnings = [];

  function handleEnvelope(envelope) {
    if (envelope.type === 'bridge.open_im_attempt') {
      attachOpenImAttemptResponse(report.imOpenAttempts, envelope);
    }

    const title = envelope.payload?.title || envelope.payload?.info?.title || '';
    integrityWarnings = scanWindowTitle(title, integrityWarnings);

    if (!LISTEN_WATCH_TYPES.has(envelope.type)) return;
    tracker.recordEvent(envelope);
    const p = envelope.payload || {};

    if (envelope.type === DOUDIAN_EVENTS.SHOP_IDENTITY_RESOLVED) {
      const shopInfo = p.shopInfo || p;
      shopIdentityHints.push({
        shopId: pickFirst(p.shopId, shopInfo.shopId),
        shopName: pickFirst(p.shopName, shopInfo.shopName),
        sessionPartitionKey: pickFirst(p.sessionPartitionKey, shopInfo.sessionPartitionKey),
        accountId: pickFirst(p.accountId, shopInfo.accountId),
        bridgeId: envelope.bridgeId,
        source: 'memory_cache',
      });
    }

    if (envelope.type === DOUDIAN_EVENTS.MEMORY_CACHE_CANDIDATE) {
      memoryCacheHints.push({
        bridgeId: envelope.bridgeId,
        cacheKey: p.cacheKey || '',
        apiName: p.apiName || '',
        shopId: pickFirst(p.shopId, p.shopInfo?.shopId),
        shopName: pickFirst(p.shopName, p.shopInfo?.shopName),
        sessionPartitionKey: pickFirst(p.sessionPartitionKey, p.shopInfo?.sessionPartitionKey),
        source: 'memory_cache',
      });
      processMemoryCacheCandidate(envelope);
    }

    if (envelope.type === DOUDIAN_EVENTS.CHAT_CONVERSATION_HINTS) {
      const p = envelope.payload || {};
      const hints = p.hints || p.selectedConversation || {};
      if (hints && Object.keys(hints).length) {
        latestDomHints = { ...latestDomHints, ...hints };
        const resolved = refreshConversationSelectionFromHints();
        announceGuidedSelection(resolved);
      }
    }

    if (envelope.type === DOUDIAN_EVENTS.CHAT_DOM_INSPECTION) {
      processDomInspection(envelope);
    }

    if (envelope.type === DOUDIAN_EVENTS.CHAT_HISTORY_CANDIDATE) {
      processHistoryCandidate(envelope, p);
    }

    if (envelope.type === DOUDIAN_EVENTS.CHAT_HISTORY_SNAPSHOT) {
      processHistorySnapshot(envelope);
    }

    if (envelope.type === DOUDIAN_EVENTS.MESSAGE_NETWORK_CANDIDATE) {
      const apiName = resolveApiName(p.urlPath || p.url || '');
      if (!/message|history|detail|get_link_info/i.test(apiName + (p.urlPath || p.url || ''))) return;
      const shopInfo = {
        shopId: pickFirst(p.shopId, p.shopInfo?.shopId),
        shopName: pickFirst(p.shopName, p.shopInfo?.shopName),
      };
      const payload = p.body || p.sample || p.payload || p;
      const parsed = parseChatHistoryPayload(payload, shopInfo, {
        url: p.urlPath || p.url || '',
        conversationId: p.shopHints?.conversationId,
        buyerId: p.shopHints?.buyerId,
      });
      if (parsed.conversationId || parsed.buyerId || parsed.buyerName) {
        updateConversationSelection(report, parsed);
      }
      if (parsed.messages.length > 0) {
        ingestHistoryItems(parsed.messages, shopInfo, {
          source: 'ipc',
          bridgeId: envelope.bridgeId,
          conversationId: parsed.conversationId,
          buyerId: parsed.buyerId,
          buyerName: parsed.buyerName,
        });
      }
    }
  }

  if (mockMode && mockGuidedMode) {
    const fixtures = createMockFixtures();
    const shopInfo = options.mockShopInfo || {
      shopId: '263636465',
      shopName: 'XY祥钰珠宝',
    };
    const bubbleMessages = [
      {
        text: '在在在',
        direction: 'buyer',
        directionConfidence: 75,
        domArea: 'chatBubbleArea',
        bubbleTrusted: true,
        messageAreaTrusted: true,
      },
      {
        text: '亲亲，很高兴为您服务',
        direction: 'seller',
        directionConfidence: 80,
        domArea: 'chatBubbleArea',
        bubbleTrusted: true,
        messageAreaTrusted: true,
      },
    ];

    report.guidedMode = true;
    report.imBridgeSeen = 1;
    report.activeImShopCount = 1;
    report.activeImShops = [{ shopId: shopInfo.shopId, shopName: shopInfo.shopName }];
    report.imOpenSuccess = true;
    report.shopReportValid = true;
    report.activeShop = { shopId: shopInfo.shopId, shopName: shopInfo.shopName };

    ingestHistoryItems(bubbleMessages, shopInfo, { source: 'dom' });
    const beforeSelectionInserted = report.insertedMessageCount;
    const beforeSelectionCandidates = report.candidateOnlyCount;

    latestDomHints = {
      buyerId: 'buyer_guided_***',
      buyerName: '测试买家',
      buyerNameSource: 'chat_header',
      buyerIdSource: 'chat_area',
    };
    const resolved = refreshConversationSelectionFromHints();
    announceGuidedSelection(resolved);

    ingestHistoryItems(bubbleMessages, shopInfo, {
      source: 'dom',
      conversationId: report.conversationId,
      buyerId: report.buyerId,
      buyerName: report.buyerName,
      conversationIdSource: report.conversationIdSource,
    });
    ingestHistoryItems(bubbleMessages, shopInfo, {
      source: 'dom',
      conversationId: report.conversationId,
      buyerId: report.buyerId,
      buyerName: report.buyerName,
      conversationIdSource: report.conversationIdSource,
    });

    report.durationMs = Date.now() - startedAt;
    report.finishedAt = new Date().toISOString();
    refreshDirectionCounts();
    tryFinishSuccess();
    if (!captured) finalizeGuidedOutcome();

    report.mockGuidedSummary = {
      beforeSelectionInserted,
      beforeSelectionCandidates,
      afterSelectionInserted: report.insertedMessageCount,
      dedupeHitCount: report.dedupeHitCount,
      fallbackConversationIdUsed: report.fallbackConversationIdUsed,
      conversationIdSource: report.conversationIdSource,
      resolved,
    };
    return report;
  }

  if (mockMode) {
    const fixtures = createMockFixtures();
    const shopInfo = options.mockShopInfo || {
      shopId: '263636465',
      shopName: 'XY祥钰珠宝',
    };
    const history = options.mockHistory || fixtures.chatHistory;

    report.imBridgeSeen = 1;
    report.activeImShopCount = 1;
    report.activeImShops = [{ shopId: shopInfo.shopId, shopName: shopInfo.shopName }];
    report.imOpenSuccess = true;

    const parsed = parseChatHistoryPayload(
      { messages: history.messages },
      shopInfo,
      {
        conversationId: history.conversationId,
        buyerId: history.buyerId,
        buyerName: history.buyerName,
      }
    );

    ingestHistoryItems(parsed.messages.length ? parsed.messages : history.messages, shopInfo, {
      source: 'memory_cache',
      conversationId: history.conversationId,
      buyerId: history.buyerId,
      buyerName: history.buyerName,
    });

    shopIdentityHints.push({
      shopId: shopInfo.shopId,
      shopName: shopInfo.shopName,
      source: 'memory_cache',
    });
    applyShopStats(parseStdoutBusinessSignals([
      `init window with accounts shopId=${shopInfo.shopId} shopName=${shopInfo.shopName}`,
    ]));
    report.activeImShopCount = Math.max(report.activeImShopCount || 0, 1);
    report.activeImShops = report.activeImShops?.length
      ? report.activeImShops
      : [{ shopId: shopInfo.shopId, shopName: shopInfo.shopName }];
    report.shopReportValid = report.shopReportValid !== false;

    tryFinishSuccess();
    if (!report.success) {
      report.reason = 'mock_chat_history_pipeline_failed';
      report.errors.push('mock 历史消息未能入库');
    } else {
      report.reason = 'mock_chat_history_pipeline_ok';
    }

    report.durationMs = Date.now() - startedAt;
    report.finishedAt = new Date().toISOString();
    report.sampleMessages = maskHistorySamples(
      report.sampleMessages.map((m, i) => ({
        ...m,
        direction: history.messages[i]?.direction || m.direction,
      })),
      10
    );
    refreshDirectionCounts();
    const trust = evaluateHistoryTrust({
      ...report,
      shopReportValid: report.shopReportValid !== false,
    });
    report.historyTrusted = trust.historyTrusted;
    report.conversationTrusted = trust.conversationTrusted;
    report.success = trust.historyTrusted;
    report.reason = trust.historyTrusted ? 'mock_chat_history_pipeline_ok' : trust.reason || report.reason;
    return report;
  }

  if (!fs.existsSync(exePath)) {
    report.errors.push(`doudian.exe 不存在: ${exePath}`);
    report.reason = 'doudian_exe_missing';
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return report;
  }

  const wsServer = getDoudianWsServer({ port: bridgePort });
  const { startBridgeWsServer } = require('./auto-verify-utils');
  const wsStarted = await startBridgeWsServer(wsServer, report);
  if (!wsStarted) {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return report;
  }
  wsServer.on('*', handleEnvelope);

  const shopInfoSent = new Set();
  const child = spawn(exePath, [], {
    cwd: installDir,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  const onStdoutChunk = (buf) => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const redacted = redactStdoutLine(trimmed);
      if (redacted) {
        stdoutLines.push(redacted);
        integrityWarnings = scanStdoutLine(redacted, integrityWarnings);
      }
    }
  };
  child.stdout.on('data', onStdoutChunk);
  child.stderr.on('data', onStdoutChunk);

  console.log(`[抖店桥] 聊天历史验证已启动，超时 ${timeoutMinutes} 分钟`);
  await sleep(3000);

  const imResult = await runDoudianImWorkspacePhase({
    wsServer,
    bridgeTracker: tracker,
    report,
    timeoutMs: DEFAULT_IM_WAIT_MS,
    openIfMissing: true,
    onTick: () => {
      applyShopStats(parseStdoutBusinessSignals(stdoutLines));
      applyBridgeClassificationToReport(report, tracker);
      applyIntegrityWarningsToReport(report, integrityWarnings);
    },
    logPrefix: '[抖店桥]',
  });

  applyBridgeClassificationToReport(report, tracker);
  applyIntegrityWarningsToReport(report, integrityWarnings);

  if (imResult.imBridgeSeen !== 1) {
    report.success = false;
    report.reason = 'im_workspace_not_opened';
    report.durationMs = Date.now() - startedAt;
    report.finishedAt = new Date().toISOString();
    applyShopStats(parseStdoutBusinessSignals(stdoutLines));
    report.unknownImBridgeCount = report.unknownImBridges?.length || 0;
    report.warnings.push('IM workspace 未在时限内打开，未进入历史消息读取阶段');
    report.nextActions = [
      '确认 patch 已应用到测试目录并重启抖店',
      '运行 npm run doudian:auto-verify-im 单独验证 IM bridge',
      '运行 npm run doudian:test-history-im-open 验证 IM 打开链路',
      '检查 debug.open_im_workspace 是否收到 bridge.open_im_attempt 回执',
    ];
    try {
      child.unref();
    } catch {
      // ignore
    }
    return report;
  }

  if (guidedMode) {
    console.log('[抖店桥] guided 模式: IM 已就绪，等待您手动点开买家会话...');
  } else {
    console.log('[抖店桥] 阶段2: IM 已就绪，等待用户选中买家会话并读取历史消息...');
  }
  historyWaitStarted = Date.now();
  const historyTimeoutMs = timeoutMinutes * 60 * 1000;
  const briefingMs = guidedMode ? GUIDED_BRIEFING_MS : BRIEFING_MS;
  const inspectIntervalMs = guidedMode ? GUIDED_HINTS_INTERVAL_MS : HISTORY_READ_INTERVAL_MS;

  while (!captured && Date.now() - historyWaitStarted < historyTimeoutMs) {
    report.imBridgeSeen = Math.max(report.imBridgeSeen || 0, tracker.hasImBridge() ? 1 : 0);
    applyBridgeClassificationToReport(report, tracker);
    applyIntegrityWarningsToReport(report, integrityWarnings);
    tracker.refreshShopStats();
    applyShopStats(parseStdoutBusinessSignals(stdoutLines));
    report.unknownImBridgeCount = report.unknownImBridges?.length || 0;

    const imBridgeIds = tracker.getImBridgeIds();
    for (const id of imBridgeIds) {
      if (!shopInfoSent.has(id)) {
        wsServer.sendDebugCommand(id, 'debug.get_shop_info', {});
        shopInfoSent.add(id);
      }
    }

    const resolved = refreshConversationSelectionFromHints();
    announceGuidedSelection(resolved);

    if (guidedMode && Date.now() - lastConversationHintsAt >= GUIDED_HINTS_INTERVAL_MS) {
      for (const id of imBridgeIds) {
        wsServer.sendDebugCommand(id, 'debug.get_conversation_hints', {});
      }
      lastConversationHintsAt = Date.now();
    }

    if (Date.now() - lastDomInspectAt >= inspectIntervalMs) {
      for (const id of imBridgeIds) {
        wsServer.sendDebugCommand(id, 'debug.inspect_chat_dom', {});
      }
      lastDomInspectAt = Date.now();
    }

    const shouldReadHistory =
      guidedMode && selectionAnnounced
        ? Date.now() - lastHistoryReadAt >= inspectIntervalMs
        : !guidedMode && Date.now() - lastHistoryReadAt >= HISTORY_READ_INTERVAL_MS;

    if (shouldReadHistory) {
      for (const id of imBridgeIds) {
        wsServer.sendDebugCommand(id, 'debug.read_current_chat_history', {});
      }
      lastHistoryReadAt = Date.now();
    }

    if (guidedMode && pendingImmediateHistoryRead) {
      for (const id of imBridgeIds) {
        wsServer.sendDebugCommand(id, 'debug.read_current_chat_history', {});
        wsServer.sendDebugCommand(id, 'debug.inspect_chat_dom', {});
      }
      pendingImmediateHistoryRead = false;
      lastHistoryReadAt = Date.now();
      lastDomInspectAt = Date.now();
    }

    if (Date.now() - lastBriefingAt >= briefingMs) {
      if (guidedMode) {
        printGuidedBriefing(report);
      } else {
        console.log('[抖店桥] history summary:');
        console.log(`IM已打开: ${(report.imBridgeSeen || 0) >= 1}`);
        console.log(`activeShop: ${getActiveShopLabel(report)}`);
        console.log(`selectedConversationDetected: ${report.selectedConversationDetected}`);
        console.log(`conversationId: ${report.conversationId ? `${String(report.conversationId).slice(0, 8)}***` : ''}`);
        console.log(`buyerName: ${report.buyerName || ''}`);
        console.log(`historyMessageCount: ${report.historyMessageCount}`);
        console.log(`validatedMessageCount: ${report.validatedMessageCount}`);
        console.log(`insertedMessageCount: ${report.insertedMessageCount}`);
        console.log(`candidateBubbleCount: ${report.candidateBubbleCount}`);
        console.log(`trustedBubbleCount: ${report.trustedBubbleCount}`);
        console.log(`memoryHistoryCandidateCount: ${report.memoryHistoryCandidateCount}`);
        console.log(`conversationTrusted: ${report.conversationTrusted}`);
        console.log(`historyTrusted: ${report.historyTrusted}`);
        console.log(`状态: ${getHistoryStatus(report)}`);
      }
      lastBriefingAt = Date.now();
    }

    await sleep(1000);
  }

  report.durationMs = Date.now() - startedAt;
  report.finishedAt = new Date().toISOString();
  applyShopStats(parseStdoutBusinessSignals(stdoutLines));
  report.imBridgeSeen = report.imBridgeSeen || (tracker.hasImBridge() ? 1 : 0);
  applyBridgeClassificationToReport(report, tracker);
  applyIntegrityWarningsToReport(report, integrityWarnings);

  if (!report.waitedForUserSelectionMs && report.userSelectionDetectedAt) {
    report.waitedForUserSelectionMs = historyWaitStarted
      ? Date.parse(report.userSelectionDetectedAt) - historyWaitStarted
      : 0;
  }

  if (!captured) {
    finalizeHistoryOutcome();
    if (guidedMode && report.reason === 'timeout_no_selected_conversation') {
      report.warnings.push('超时内未检测到买家会话选中，DOM 候选已写入 capture_candidates');
    } else if (report.reason === 'no_selected_conversation' || report.reason === 'selected_conversation_name_is_ui_noise') {
      report.nextActions = [
        '请在 IM 工作台手动点击一个有历史记录的真实买家会话',
        '避免选中快捷短语/客户资料等 UI 区域',
        '延长等待: npm run doudian:verify-chat-history -- --timeout-minutes 30',
      ];
    } else if (report.reason === 'history_message_not_found') {
      report.nextActions = [
        '已检测到会话选中，但未解析到历史消息；确认会话有聊天记录',
        '检查 memory cache / DOM 聊天气泡区读取是否正常',
      ];
    } else if (report.reason === 'history_candidates_wrong_shop' || report.reason === 'history_candidates_untrusted') {
      report.warnings.push('捕获到历史候选，但未通过信任校验，已拒绝写入 platform_messages');
      report.nextActions = [
        '确认 activeShop 与当前 IM 页一致',
        '仅聊天气泡区消息才会入正式表；侧边栏/商品卡片会进入 capture_candidates',
        '运行 npm run doudian:cleanup-bad-history 清理误入库数据',
      ];
    } else {
      report.nextActions = [
        '检查 DOM 选择器与 memory cache 历史接口',
        '运行 npm run doudian:verify-chat-history:test-mock 验证校验链路',
      ];
    }
  } else {
    report.nextActions = [
      '聊天历史链路已验证，可继续对接自动回复前的消息同步',
      '再次运行可验证 dedupe 命中',
    ];
  }

  try {
    child.unref();
  } catch {
    // ignore
  }

  return report;
}

function shouldEnterHistoryStage(imResult = {}) {
  return Number(imResult.imBridgeSeen || 0) === 1;
}

module.exports = {
  runChatHistorySession,
  parseTimeoutMinutes,
  parseGuidedTimeoutMinutes,
  buildHistoryTextReport,
  buildGuidedHistoryTextReport,
  printGuidedBriefing,
  shouldEnterHistoryStage,
  DEFAULT_TIMEOUT_MINUTES,
  DEFAULT_GUIDED_TIMEOUT_MINUTES,
  BRIEFING_MS,
  GUIDED_BRIEFING_MS,
};
