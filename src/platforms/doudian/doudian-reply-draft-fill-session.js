const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { getDoudianWsServer } = require('./doudian-ws-server');
const { DOUDIAN_EVENTS } = require('./doudian-types');
const { getDoudianConfig } = require('../../shared/config');
const { getLatestDraftOnlyReply, getReplyDraftById, closeDb } = require('./doudian-data-store');
const {
  analyzeReplyEditorInspection,
  matchDraftToConversation,
  EDITOR_CONFIDENCE_THRESHOLD,
} = require('./doudian-reply-editor-detector');
const { pickFirst } = require('./doudian-shop-utils');
const { parseStdoutBusinessSignals, redactStdoutLine } = require('./doudian-stdout-business-parser');
const {
  buildShopStatsSnapshot,
  applyShopStatsToTarget,
} = require('./doudian-shop-stats-aggregator');
const { createAccountShopMap } = require('./doudian-account-shop-map');
const {
  resolveSelectedConversation,
  applySelectedConversationToReport,
  isConversationSelected,
  buildFallbackConversationId,
} = require('./doudian-conversation-resolver');
const {
  scanStdoutLine,
  scanWindowTitle,
  applyIntegrityWarningsToReport,
} = require('./doudian-integrity-warning-monitor');
const {
  runDoudianImWorkspacePhase,
  attachOpenImAttemptResponse,
  DEFAULT_IM_WAIT_MS,
} = require('./doudian-im-workspace-ensurer');

const DEFAULT_TIMEOUT_MINUTES = 30;
const GUIDED_BRIEFING_MS = 5000;
const HINTS_INTERVAL_MS = 5000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseTimeoutMinutes(argv = [], defaultMinutes = DEFAULT_TIMEOUT_MINUTES) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--timeout-minutes' && argv[i + 1]) {
      return Math.max(1, Number(argv[i + 1]) || defaultMinutes);
    }
  }
  return defaultMinutes;
}

function resolveDbPath(options = {}) {
  if (options.dbPath) return options.dbPath;
  if (process.env.DOUDIAN_VERIFY_DB) return process.env.DOUDIAN_VERIFY_DB;
  const candidates = [
    path.join(process.cwd(), 'logs', 'doudian-chat-history-guided.db'),
    path.join(process.cwd(), 'logs', 'doudian-chat-history.db'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function maskIdForReport(value = '') {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 8) return `${s.slice(0, 2)}***`;
  return `${s.slice(0, 8)}***`;
}

function maskTextForReport(text = '', maxLen = 120) {
  const s = String(text || '').slice(0, maxLen);
  return s
    .replace(/1\d{10}/g, (m) => `${m.slice(0, 3)}****${m.slice(-4)}`)
    .replace(/\b\d{12,22}\b/g, (m) => `${m.slice(0, 4)}***${m.slice(-4)}`);
}

function getActiveShopContext(report) {
  const shop = (report.activeImShops || [])[0] || report.activeShop || {};
  return {
    shopId: pickFirst(shop.shopId, report.activeShop?.shopId),
    shopName: pickFirst(shop.shopName, report.activeShop?.shopName),
  };
}

function applyBridgeClassificationToReport(report, tracker) {
  const counts =
    typeof tracker.getBridgeClassificationCounts === 'function'
      ? tracker.getBridgeClassificationCounts()
      : {
          imBridgeSeen: tracker.hasImBridge?.() ? 1 : 0,
        };
  report.imBridgeSeen = Math.max(report.imBridgeSeen ? 1 : 0, counts.imBridgeSeen);
  return report;
}

function buildReplyEditorTextReport(report) {
  const lines = [];
  lines.push('=== 抖店客服输入框诊断报告 ===');
  lines.push(`时间: ${report.finishedAt || new Date().toISOString()}`);
  lines.push(`结果: ${report.success ? '成功' : '失败'}`);
  lines.push(`reason: ${report.reason || ''}`);
  lines.push(`mode: ${report.mode || 'verify'}`);
  lines.push(`imBridgeSeen: ${report.imBridgeSeen ?? 0}`);
  lines.push(`activeShop: ${report.activeShop?.shopId || ''} / ${report.activeShop?.shopName || ''}`);
  lines.push(`selectedConversationDetected: ${report.selectedConversationDetected}`);
  lines.push(`conversationId: ${report.conversationId || ''}`);
  lines.push(`buyerId: ${report.buyerId || ''}`);
  lines.push(`editorFound: ${report.editorFound}`);
  lines.push(`editorConfidence: ${report.editorConfidence ?? 0}`);
  lines.push(`editorSelectorPath: ${report.editorSelectorPath || ''}`);
  lines.push(`editorType: ${report.editorType || ''}`);
  lines.push(`sendButtonFound: ${report.sendButtonFound}`);
  lines.push(`sendButtonConfidence: ${report.sendButtonConfidence ?? 0}`);
  lines.push(`sendButtonEnabled: ${report.sendButtonEnabled}`);
  lines.push(`sendButtonText: ${report.sendButtonText || ''}`);
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

function buildFillDraftTextReport(report) {
  const lines = buildReplyEditorTextReport(report);
  lines.splice(4, 0, `draftId: ${report.draftId ?? 0}`);
  lines.push(`shopId: ${report.shopId || ''}`);
  lines.push(`shopName: ${report.shopName || ''}`);
  lines.push(`draftText: ${report.draftText || ''}`);
  lines.push(`shopMatched: ${report.shopMatched}`);
  lines.push(`conversationMatched: ${report.conversationMatched}`);
  lines.push(`buyerMatched: ${report.buyerMatched}`);
  lines.push(`filled: ${report.filled}`);
  lines.push(`fillVerified: ${report.fillVerified}`);
  lines.push(`sent: ${report.sent}`);
  lines.push(`sendNotCalled: ${report.sendNotCalled}`);
  return lines;
}

function isActiveShopResolved(report) {
  const shop = (report.activeImShops || [])[0] || report.activeShop || {};
  return Boolean(String(shop.shopId || '').trim());
}

function getGuidedReplyEditorStatus(report) {
  if ((report.imBridgeSeen || 0) < 1) {
    return '等待 IM workspace 打开...';
  }
  if (report.selectedConversationDetected && !report.activeShopResolved) {
    return '已检测到买家会话，等待 IM bridge 归属到店铺（partition/memoryCache 映射）...';
  }
  if (!report.selectedConversationDetected) {
    if (report.mode === 'fill') {
      return '请在抖店聊天窗口手动点开草稿对应的买家会话';
    }
    return '请在抖店聊天窗口手动点开一个有聊天消息的买家会话';
  }
  if (report.mode === 'fill') {
    if (report.success && report.filled) return '草稿已填入输入框，未发送';
    if (report.reason === 'draft_conversation_mismatch') return '当前会话与草稿不匹配';
    return '正在检测输入框并填入草稿...';
  }
  if (report.success) return '输入框与发送按钮检测通过';
  if (report.editorFound && !report.sendButtonFound) return '已找到输入框，等待发送按钮...';
  return '正在检测输入框与发送按钮...';
}

function printGuidedReplyEditorBriefing(report) {
  const active = getActiveShopContext(report);
  console.log('[抖店桥] reply editor guided:');
  console.log(`IM已打开: ${(report.imBridgeSeen || 0) >= 1}`);
  console.log(`activeShop: ${active.shopId || ''} / ${active.shopName || ''}`);
  console.log(`activeShopResolved: ${report.activeShopResolved}`);
  console.log(`selectedConversationDetected: ${report.selectedConversationDetected}`);
  console.log(`buyerId: ${report.buyerId || ''}`);
  console.log(`conversationId: ${report.conversationId || ''}`);
  if (report.mode === 'fill' && report.draftId) {
    console.log(`draftId: ${report.draftId}`);
  }
  if (!report.activeShopResolved && report.activeShopWaitReason) {
    console.log(`activeShopWaitReason: ${report.activeShopWaitReason}`);
  }
  console.log(`状态: ${getGuidedReplyEditorStatus(report)}`);
}

function buildGuidedReplyEditorTextReport(report) {
  const lines = buildReplyEditorTextReport(report);
  lines.splice(4, 0, `guidedMode: ${report.guidedMode || false}`);
  if (report.waitedForUserSelectionMs != null) {
    lines.push(`waitedForUserSelectionMs: ${report.waitedForUserSelectionMs}`);
  }
  if (report.userSelectionDetectedAt) {
    lines.push(`userSelectionDetectedAt: ${report.userSelectionDetectedAt}`);
  }
  lines.push(`activeImShopCount: ${report.activeImShopCount ?? 0}`);
  lines.push(`activeShopResolved: ${report.activeShopResolved ?? false}`);
  lines.push(`activeShopWaitReason: ${report.activeShopWaitReason || ''}`);
  lines.push(`memoryCacheHintsCount: ${report.memoryCacheHintsCount ?? 0}`);
  lines.push(`bridgeIdToPartitionKeyCount: ${report.bridgeIdToPartitionKeyCount ?? 0}`);
  lines.push(`partitionKeyToShopCount: ${report.partitionKeyToShopCount ?? 0}`);
  if (report.runLock) {
    lines.push(
      `runLock: acquired=${report.runLock.acquired} forceKill=${report.runLock.forceKill || false} reason=${report.runLock.reason || ''}`
    );
  }
  if (report.portGuard) {
    lines.push(
      `portGuard: port=${report.portGuard.port} occupied=${report.portGuard.wasOccupied} success=${report.portGuard.success} reason=${report.portGuard.reason || ''}`
    );
  }
  lines.push(`sent: ${report.sent}`);
  lines.push(`sendNotCalled: ${report.sendNotCalled}`);
  return lines;
}

function buildGuidedFillDraftTextReport(report) {
  const lines = buildGuidedReplyEditorTextReport(report);
  const idx = lines.findIndex((l) => l.startsWith('shopId:'));
  if (idx >= 0) {
    lines.splice(idx, 0, `currentConversationId: ${report.currentConversationId || ''}`);
    lines.splice(idx + 1, 0, `currentBuyerId: ${report.currentBuyerId || ''}`);
  } else {
    lines.push(`currentConversationId: ${report.currentConversationId || ''}`);
    lines.push(`currentBuyerId: ${report.currentBuyerId || ''}`);
  }
  lines.push(`draftStatusAfter: ${report.draftStatusAfter || ''}`);
  return lines;
}

function buildMockEditorInspectionPayload(shopInfo = {}) {
  return {
    viewport: { width: 1400, height: 900 },
    editorCandidates: [
      {
        selectorPath: 'div.composer > textarea.reply-input',
        editorType: 'textarea',
        rect: { x: 340, y: 780, width: 520, height: 80 },
        editorTextBefore: '',
        placeholder: '请输入消息',
        className: 'reply-input composer-textarea',
        score: 65,
      },
    ],
    sendButtonCandidates: [
      {
        selectorPath: 'div.composer > button.send-btn',
        text: '发送',
        rect: { x: 880, y: 800, width: 64, height: 32 },
        sendButtonEnabled: true,
        score: 55,
      },
    ],
    conversationId: shopInfo.conversationId || '',
    buyerId: shopInfo.buyerId || '',
    buyerName: shopInfo.buyerName || '',
  };
}

function printReplyEditorBriefing(report) {
  console.log('[抖店桥] reply-editor 状态:');
  console.log(`IM已打开: ${(report.imBridgeSeen || 0) >= 1}`);
  console.log(`activeShop: ${getActiveShopContext(report).shopId || ''} / ${getActiveShopContext(report).shopName || ''}`);
  console.log(`selectedConversationDetected: ${report.selectedConversationDetected}`);
  console.log(`conversationId: ${report.conversationId || ''}`);
  console.log(`buyerId: ${report.buyerId || ''}`);
  if (report.mode === 'fill') {
    console.log(`draftId: ${report.draftId ?? 0}`);
    console.log(`filled: ${report.filled}`);
    console.log(`fillVerified: ${report.fillVerified}`);
    console.log(`sent: ${report.sent}`);
    console.log(`sendNotCalled: ${report.sendNotCalled}`);
  } else {
    console.log(`editorFound: ${report.editorFound}`);
    console.log(`editorConfidence: ${report.editorConfidence ?? 0}`);
    console.log(`sendButtonFound: ${report.sendButtonFound}`);
    console.log(`sendButtonEnabled: ${report.sendButtonEnabled}`);
  }
  console.log(`reason: ${report.reason || '(等待中)'}`);
}

async function runReplyEditorSession(options = {}) {
  const cfg = getDoudianConfig();
  const knownShops = cfg.knownShops || [];
  const bridgePort = Number(options.bridgePort || cfg.bridgePort || 19527);
  const installDir = options.installDir;
  const exePath = installDir ? path.join(installDir, 'doudian.exe') : '';
  const mode = options.mode === 'fill' ? 'fill' : 'verify';
  const guidedMode = Boolean(options.guidedMode);
  const mockMode = Boolean(options.mockMode);
  const mockGuidedMode = Boolean(options.mockGuidedMode);
  const timeoutMinutes = Number(options.timeoutMinutes || DEFAULT_TIMEOUT_MINUTES);
  const startedAt = Date.now();

  const report = {
    success: false,
    reason: '',
    mode,
    guidedMode,
    imBridgeSeen: 0,
    activeImShopCount: 0,
    activeShop: { shopId: '', shopName: '' },
    activeShopResolved: false,
    activeShopWaitReason: '',
    imBridgeIds: [],
    activeImBridgeIds: [],
    unknownImBridges: [],
    memoryCacheHintsCount: 0,
    bridgeIdToPartitionKeyCount: 0,
    partitionKeyToShopCount: 0,
    loggedInShopCount: 0,
    loggedInShops: [],
    shopResolveDiagnostics: [],
    fallbackConversationIdUsed: false,
    conversationIdSource: '',
    selectedConversationDetected: false,
    conversationId: '',
    buyerId: '',
    buyerName: '',
    currentConversationId: '',
    currentBuyerId: '',
    editorFound: false,
    editorConfidence: 0,
    editorSelectorPath: '',
    editorType: '',
    sendButtonFound: false,
    sendButtonConfidence: 0,
    sendButtonEnabled: false,
    sendButtonText: '',
    draftId: 0,
    shopId: '',
    shopName: '',
    draftText: '',
    draftStatusAfter: '',
    shopMatched: false,
    conversationMatched: false,
    buyerMatched: false,
    filled: false,
    fillVerified: false,
    sent: false,
    sendNotCalled: true,
    waitedForUserSelectionMs: 0,
    userSelectionDetectedAt: '',
    warnings: [],
    errors: [],
    nextActions: [],
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: '',
    durationMs: 0,
    timeoutMinutes,
    patchManifest: options.patchManifest || null,
    portGuard: options.portGuard || null,
    runLock: options.runLock || null,
  };

  const reasonNoDraft = guidedMode ? 'no_draft_only_reply' : 'no_draft_available';
  const reasonNoConversation = guidedMode ? 'timeout_no_selected_conversation' : 'no_selected_conversation';
  const reasonDraftMismatch = guidedMode ? 'draft_conversation_mismatch' : 'draft_session_mismatch';

  let draftRow = null;
  if (mode === 'fill' && !mockMode) {
    const dbPath = resolveDbPath(options);
    if (!dbPath && !mockMode) {
      report.reason = reasonNoDraft;
      report.errors.push('未找到 SQLite 草稿库，请先运行 ai-draft-reply');
      report.nextActions = ['npm run doudian:ai-draft-reply', 'npm run doudian:verify-chat-history-guided'];
      report.finishedAt = new Date().toISOString();
      report.durationMs = Date.now() - startedAt;
      return sanitizeReport(report);
    }
    if (dbPath) {
      process.env.DOUDIAN_VERIFY_DB = dbPath;
      closeDb();
      draftRow = getLatestDraftOnlyReply({ platform: 'doudian', status: 'draft_only' });
    }
    if (!draftRow && !mockMode) {
      report.reason = reasonNoDraft;
      report.errors.push('platform_reply_drafts 中无 status=draft_only 草稿');
      report.nextActions = ['npm run doudian:ai-draft-reply'];
      report.finishedAt = new Date().toISOString();
      report.durationMs = Date.now() - startedAt;
      return sanitizeReport(report);
    }
    if (draftRow && (draftRow.status === 'risk_blocked' || draftRow.risk_level === 'high')) {
      report.reason = guidedMode ? 'risk_blocked_draft' : 'risk_blocked_draft';
      report.draftId = draftRow.id;
      report.errors.push('风险草稿不允许填入输入框');
      report.finishedAt = new Date().toISOString();
      report.durationMs = Date.now() - startedAt;
      return sanitizeReport(report);
    }
    if (draftRow) {
      report.draftId = draftRow.id;
      report.shopId = draftRow.shop_id || '';
      report.shopName = draftRow.shop_name || '';
      report.draftText = maskTextForReport(draftRow.draft_text || '');
    }
  }

  if (!mockMode && !fs.existsSync(exePath)) {
    report.errors.push(`doudian.exe 不存在: ${exePath}`);
    report.reason = 'doudian_exe_missing';
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeReport(report);
  }

  const { ShopBridgeTracker, LISTEN_WATCH_TYPES } = require('../../../scripts/lib/shop-bridge-tracker');
  const tracker = new ShopBridgeTracker({ knownShops });
  let integrityWarnings = [];
  let stdoutLines = [];
  let latestDomHints = {};
  let selectionAnnounced = false;
  let completed = false;
  let lastBriefingAt = 0;
  let lastHintsAt = 0;
  let lastInspectAt = 0;
  let fillAttempted = false;
  let waitStarted = 0;
  let pendingImmediateInspect = false;
  let inspectBeforeSelection = false;
  let shopWaitAnnounced = false;
  let inspectReadyAnnounced = false;
  const shopIdentityHints = [];
  const memoryCacheHints = [];

  function syncCurrentConversationFields() {
    report.currentConversationId = report.conversationId || '';
    report.currentBuyerId = report.buyerId || '';
  }

  function buildShopResolveDiagnostics() {
    const stdoutSignal = parseStdoutBusinessSignals(stdoutLines);
    const accountMap = createAccountShopMap(knownShops);
    for (const account of stdoutSignal.stdoutAccounts || []) {
      accountMap.ingestStdoutAccount(account);
    }
    for (const shop of stdoutSignal.loggedInShops || []) {
      accountMap.ingestStdoutShop(shop);
    }
    for (const hint of shopIdentityHints) {
      if (hint.shopId && accountMap.isKnownShopId(hint.shopId)) {
        accountMap.ingestIdentityHint(hint);
      }
    }
    for (const hint of memoryCacheHints) {
      accountMap.ingestMemoryCacheHint(hint);
    }

    const diagnostics = [];
    for (const bridge of tracker.getAllBridges?.() || []) {
      const isIm = bridge.isImWorkspace || (bridge.hrefs || []).some((h) => /im\.jinritemai\.com/i.test(h));
      if (!isIm) continue;
      const bridgeHint =
        shopIdentityHints.find((h) => h.bridgeId === bridge.bridgeId) ||
        memoryCacheHints.find((h) => h.bridgeId === bridge.bridgeId) ||
        null;
      const resolved = accountMap.resolveShopForBridge(bridge, bridgeHint);
      diagnostics.push({
        bridgeId: bridge.bridgeId,
        href: (bridge.hrefs || [])[0] || '',
        sessionPartitionKey: pickFirst(
          bridge.sessionPartitionKey,
          accountMap.bridgeIdToPartitionKey.get(bridge.bridgeId)
        ),
        resolvedShopId: resolved.shopId || '',
        whyUnresolved: resolved.whyUnresolved || [],
      });
    }

    report.memoryCacheHintsCount = memoryCacheHints.length;
    report.bridgeIdToPartitionKeyCount = accountMap.bridgeIdToPartitionKey.size;
    report.partitionKeyToShopCount = accountMap.partitionKeyToShop.size;
    report.shopResolveDiagnostics = diagnostics;
    report.imBridgeIds = tracker.getImBridgeIds?.() || [];
    report.activeImBridgeIds = (report.activeImShops || []).flatMap(
      (s) => s.activeImBridgeIds || s.bridgeIds || []
    );
    return accountMap;
  }

  function applyShopStats(lines) {
    const prevImBridgeSeen = report.imBridgeSeen || 0;
    const stdoutSignal = parseStdoutBusinessSignals(lines);
    const snapshot = buildShopStatsSnapshot({
      tracker,
      stdoutSignal,
      knownShops,
      shopIdentityHints,
      memoryCacheHints,
    });
    applyShopStatsToTarget(report, snapshot);
    buildShopResolveDiagnostics();
    report.imBridgeSeen = Math.max(
      prevImBridgeSeen,
      report.imBridgeSeen || 0,
      snapshot.imBridgeSeen || 0,
      tracker.hasImBridge?.() ? 1 : 0,
      report.imOpenSuccess ? 1 : 0
    );
    const active = getActiveShopContext(report);
    report.activeShop = { shopId: active.shopId, shopName: active.shopName };
    report.activeImShopCount = snapshot.activeImShopCount || 0;
    report.activeShopResolved = isActiveShopResolved(report);
    if (report.activeShopResolved) {
      report.activeShopWaitReason = '';
    } else if ((report.imBridgeSeen || 0) >= 1) {
      if (report.selectedConversationDetected) {
        report.activeShopWaitReason = 'im_bridge_shop_not_resolved';
      } else if ((report.unknownImBridges || []).length > 0) {
        report.activeShopWaitReason = 'im_bridge_shop_not_resolved';
      } else if ((report.activeImShopCount || 0) === 0 && (report.loggedInShopCount || 0) === 0) {
        report.activeShopWaitReason = 'waiting_stdout_or_memory_cache';
      } else {
        report.activeShopWaitReason = 'im_bridge_shop_not_resolved';
      }
    } else {
      report.activeShopWaitReason = 'im_workspace_not_ready';
    }
  }

  function applyFallbackConversationIfNeeded() {
    if (!isActiveShopResolved(report)) return;
    const activeShop = getActiveShopContext(report);
    if (report.conversationId || !report.buyerId || !activeShop.shopId) return;
    report.conversationId = buildFallbackConversationId(activeShop.shopId, report.buyerId);
    report.conversationIdSource = 'fallback_buyerId';
    report.fallbackConversationIdUsed = true;
    syncCurrentConversationFields();
  }

  function refreshConversationSelectionFromHints() {
    const activeShop = getActiveShopContext(report);
    const resolved = resolveSelectedConversation(
      report,
      { domHints: latestDomHints },
      activeShop
    );
    applySelectedConversationToReport(report, resolved, activeShop);
    if (isActiveShopResolved(report) && !report.conversationId && report.buyerId) {
      applyFallbackConversationIfNeeded();
    }
    syncCurrentConversationFields();
    return resolved;
  }

  function announceSelection(resolved = {}) {
    if (!isConversationSelected(resolved)) return;

    if (!selectionAnnounced) {
      selectionAnnounced = true;
      report.userSelectionDetectedAt = new Date().toISOString();
      report.waitedForUserSelectionMs = waitStarted ? Date.now() - waitStarted : 0;
      console.log('[抖店桥] 已检测到买家会话');
      console.log(`buyerId: ${maskIdForReport(report.buyerId)}`);
    }

    if (!isActiveShopResolved(report)) {
      if (!shopWaitAnnounced) {
        console.log(
          '[抖店桥] 已检测到买家会话，但 IM bridge 暂未归属到店铺，正在等待 partition/memoryCache 映射...'
        );
        shopWaitAnnounced = true;
      }
      report.activeShopResolved = false;
      if (!report.activeShopWaitReason) {
        report.activeShopWaitReason = 'im_bridge_shop_not_resolved';
      }
      if ((report.unknownImBridges || []).length > 0 && !report.warnings.includes('im_bridge_shop_unresolved')) {
        report.warnings.push('im_bridge_shop_unresolved');
      }
      return;
    }

    applyFallbackConversationIfNeeded();

    if (!inspectReadyAnnounced) {
      const action = mode === 'fill' ? '填入草稿' : '检测输入框/发送按钮';
      console.log(
        `conversationId: ${
          report.fallbackConversationIdUsed
            ? `${maskIdForReport(report.conversationId)} / fallback_buyerId`
            : maskIdForReport(report.conversationId)
        }`
      );
      console.log(`开始${action}...`);
      inspectReadyAnnounced = true;
      pendingImmediateInspect = true;
    }
  }

  function checkVerifySuccess(analysis = {}) {
    if (
      mode !== 'verify' ||
      !report.selectedConversationDetected ||
      !report.activeShopResolved ||
      !analysis.editorFound ||
      !analysis.sendButtonFound ||
      (analysis.editorConfidence || 0) < EDITOR_CONFIDENCE_THRESHOLD
    ) {
      return false;
    }
    completed = true;
    report.success = true;
    report.reason = 'reply_editor_detected';
    report.sent = false;
    report.sendNotCalled = true;
    return true;
  }

  function applyEditorInspection(payload = {}) {
    const analysis = analyzeReplyEditorInspection(payload);
    report.editorFound = analysis.editorFound;
    report.editorConfidence = analysis.editorConfidence;
    report.editorSelectorPath = analysis.editorSelectorPath || '';
    report.editorType = analysis.editorType || '';
    report.sendButtonFound = analysis.sendButtonFound;
    report.sendButtonConfidence = analysis.sendButtonConfidence;
    report.sendButtonEnabled = analysis.sendButtonEnabled !== false;
    report.sendButtonText = analysis.sendButtonText || '';

    const hints = payload.selectedConversation || payload.hints || {};
    if (payload.conversationId || payload.buyerId) {
      latestDomHints = {
        ...latestDomHints,
        conversationId: pickFirst(payload.conversationId, hints.conversationId, latestDomHints.conversationId),
        buyerId: pickFirst(payload.buyerId, hints.buyerId, latestDomHints.buyerId),
        buyerName: pickFirst(payload.buyerName, hints.buyerName, latestDomHints.buyerName),
      };
      const resolved = refreshConversationSelectionFromHints();
      announceSelection(resolved);
    }

    if (!selectionAnnounced || !report.activeShopResolved) {
      inspectBeforeSelection = !selectionAnnounced;
      return;
    }

    if (mode === 'verify') {
      if (analysis.editorFound && !analysis.sendButtonFound) {
        report.warnings.push('输入框已找到，但发送按钮未通过信任评分');
      }
      checkVerifySuccess(analysis);
    }
  }

  function applyDraftFilled(payload = {}) {
    report.sent = false;
    report.sendNotCalled = true;
    report.filled = Boolean(payload.filled);
    report.fillVerified = Boolean(payload.fillVerified);
    report.editorFound = Boolean(payload.editorFound || report.editorFound);
    report.editorSelectorPath = pickFirst(payload.editorSelectorPath, report.editorSelectorPath);
    report.sendButtonFound = Boolean(payload.sendButtonFound || report.sendButtonFound);
    report.sendButtonEnabled = payload.sendButtonEnabled !== false;
    if (payload.editorConfidence != null) {
      report.editorConfidence = payload.editorConfidence;
    }

    if (payload.success && payload.filled && payload.fillVerified) {
      completed = true;
      report.success = true;
      report.reason = 'draft_filled';
      console.log('[抖店桥] 草稿已填入输入框，但没有发送');
      console.log(`draftId: ${report.draftId ?? 0}`);
      console.log(`filled: ${report.filled}`);
      console.log(`fillVerified: ${report.fillVerified}`);
      console.log(`sent: ${report.sent}`);
      console.log(`sendNotCalled: ${report.sendNotCalled}`);
    } else if (payload.reason) {
      report.reason = payload.reason === 'fill_not_verified' ? 'draft_fill_failed' : payload.reason;
    }
  }

  function handleEnvelope(envelope) {
    if (envelope.type === 'bridge.open_im_attempt') {
      attachOpenImAttemptResponse(report.imOpenAttempts || (report.imOpenAttempts = []), envelope);
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
        accountId: pickFirst(p.accountId, p.shopInfo?.accountId),
        source: 'memory_cache',
      });
    }

    if (envelope.type === DOUDIAN_EVENTS.CHAT_CONVERSATION_HINTS) {
      const hints = p.hints || p.selectedConversation || {};
      if (hints && Object.keys(hints).length) {
        latestDomHints = { ...latestDomHints, ...hints };
        const resolved = refreshConversationSelectionFromHints();
        announceSelection(resolved);
      }
    }

    if (envelope.type === DOUDIAN_EVENTS.REPLY_EDITOR_INSPECTION) {
      applyEditorInspection(p);
    }

    if (envelope.type === DOUDIAN_EVENTS.REPLY_DRAFT_FILLED) {
      applyDraftFilled(p);
    }
  }

  function tryFillDraft(wsServer, imBridgeIds) {
    if (mode !== 'fill' || fillAttempted || !draftRow || !selectionAnnounced) return;

    if (!isActiveShopResolved(report)) {
      report.activeShopResolved = false;
      report.activeShopWaitReason = 'active_shop_not_resolved';
      return;
    }

    const activeShop = getActiveShopContext(report);
    applyFallbackConversationIfNeeded();
    syncCurrentConversationFields();
    const match = matchDraftToConversation(
      {
        shop_id: draftRow.shop_id,
        buyer_id: draftRow.buyer_id,
        conversation_id: draftRow.conversation_id,
      },
      {
        shopId: activeShop.shopId || report.shopId,
        buyerId: report.buyerId,
        conversationId: report.conversationId,
      }
    );
    report.shopMatched = match.shopMatched;
    report.conversationMatched = match.conversationMatched;
    report.buyerMatched = match.buyerMatched;

    if (!match.matched) {
      completed = true;
      report.success = false;
      report.reason = reasonDraftMismatch;
      report.errors.push('草稿 shopId/conversationId/buyerId 与当前选中会话不匹配');
      report.nextActions = [
        '请在 IM 中打开与草稿相同的买家会话',
        '或重新运行 ai-draft-reply 生成新草稿',
      ];
      return;
    }

    fillAttempted = true;
    for (const id of imBridgeIds) {
      wsServer.sendDebugCommand(id, 'debug.fill_reply_draft', {
        draftText: draftRow.draft_text || '',
        draftId: draftRow.id,
      });
    }
  }

  function finalizeOutcome() {
    report.sent = false;
    report.sendNotCalled = true;
    if (completed && report.success) return;

    if (!report.selectedConversationDetected) {
      report.success = false;
      report.reason = reasonNoConversation;
      report.nextActions = [
        guidedMode
          ? '请在 IM 工作台手动点击与草稿/诊断目标一致的买家会话后重试'
          : '请在 IM 工作台手动点击与草稿/诊断目标一致的买家会话',
        `延长等待: npm run doudian:${mode === 'fill' ? 'fill-reply-draft' : 'verify-reply-editor'}${guidedMode ? '-guided' : ''} -- --timeout-minutes 60`,
      ];
      return;
    }

    if (!report.activeShopResolved) {
      report.success = false;
      report.reason = guidedMode && mode === 'fill' ? 'active_shop_not_resolved' : 'im_bridge_shop_not_resolved';
      report.errors.push('IM bridge 店铺归属未解析，无法继续 editor 检测或草稿填入');
      report.nextActions = [
        '确认 stdout accounts 或 memoryCache partition 映射是否到达',
        '检查 unknownImBridges / shopResolveDiagnostics 报告字段',
        '对比 npm run doudian:verify-chat-history-guided 的 activeShop 归属',
      ];
      return;
    }

    if (mode === 'verify') {
      if (!report.editorFound || report.editorConfidence < EDITOR_CONFIDENCE_THRESHOLD) {
        report.success = false;
        report.reason = 'reply_editor_not_found';
        report.nextActions = [
          '确认 IM 聊天窗口底部输入区域可见',
          '检查 doudian-reply-editor-snippet 选择器是否需要更新',
        ];
        return;
      }
      if (!report.sendButtonFound) {
        report.success = false;
        report.reason = 'send_button_not_found';
        report.nextActions = ['确认发送按钮在输入框附近可见'];
        return;
      }
    }

    if (mode === 'fill' && !report.filled) {
      report.success = false;
      report.reason = report.reason || (guidedMode ? 'draft_fill_failed' : 'fill_not_verified');
    }
  }

  function attachDraftStatusAfter() {
    if (mode !== 'fill' || !report.draftId || report.draftStatusAfter) return;
    try {
      const row = getReplyDraftById(report.draftId);
      report.draftStatusAfter = row?.status || '';
    } catch {
      report.draftStatusAfter = '';
    }
  }

  if (mockMode && mockGuidedMode) {
    const shopInfo = options.mockShopInfo || {
      shopId: '263636465',
      shopName: 'XY祥钰珠宝',
    };
    const mockBuyerId = options.mockBuyerId || 'buyer_guided_reply_001';
    const mockConversationId =
      options.mockConversationId || `doudian:${shopInfo.shopId}:buyer:${mockBuyerId}`;

    if (mode === 'fill') {
      draftRow = {
        id: options.mockDraftId || 99,
        shop_id: shopInfo.shopId,
        shop_name: shopInfo.shopName,
        conversation_id: mockConversationId,
        buyer_id: mockBuyerId,
        draft_text: '亲亲，在的，请问您看中哪一款？',
        status: 'draft_only',
        risk_level: 'low',
      };
      report.draftId = draftRow.id;
      report.shopId = draftRow.shop_id;
      report.shopName = draftRow.shop_name;
      report.draftText = maskTextForReport(draftRow.draft_text);
    }

    report.imBridgeSeen = 1;
    report.imOpenSuccess = true;
    report.activeImShopCount = 1;
    report.activeImShops = [{ shopId: shopInfo.shopId, shopName: shopInfo.shopName, bridgeIds: ['mock-bridge'] }];
    report.activeShop = { shopId: shopInfo.shopId, shopName: shopInfo.shopName };
    report.activeShopResolved = true;
    report.loggedInShopCount = 1;
    report.loggedInShops = [{ shopId: shopInfo.shopId, shopName: shopInfo.shopName }];
    waitStarted = Date.now();

    const editorOnlyPayload = buildMockEditorInspectionPayload({});
    applyEditorInspection(editorOnlyPayload);
    const inspectedBeforeSelection = inspectBeforeSelection && !selectionAnnounced;

    latestDomHints = {
      buyerId: mockBuyerId,
      conversationId: mockConversationId,
      buyerName: '测试买家',
      buyerNameSource: 'chat_header',
    };
    const resolved = refreshConversationSelectionFromHints();
    announceSelection(resolved);

    if (mode === 'verify') {
      applyEditorInspection({
        ...buildMockEditorInspectionPayload({
          conversationId: mockConversationId,
          buyerId: mockBuyerId,
        }),
        conversationId: mockConversationId,
        buyerId: mockBuyerId,
      });
    } else {
      const activeShop = getActiveShopContext(report);
      const match = matchDraftToConversation(draftRow, {
        shopId: activeShop.shopId || report.shopId,
        buyerId: report.buyerId,
        conversationId: report.conversationId,
      });
      report.shopMatched = match.shopMatched;
      report.conversationMatched = match.conversationMatched;
      report.buyerMatched = match.buyerMatched;
      if (match.matched) {
        applyDraftFilled({
          success: true,
          filled: true,
          fillVerified: true,
          editorFound: true,
          editorConfidence: 72,
          sendButtonFound: true,
          sendButtonEnabled: true,
          sent: false,
          sendNotCalled: true,
        });
        report.draftStatusAfter = 'draft_only';
      }
    }

    if (!completed) finalizeOutcome();

    report.mockGuidedSummary = {
      inspectedBeforeSelection,
      selectionAnnounced,
      completed,
      reason: report.reason,
    };
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    attachDraftStatusAfter();
    return sanitizeReport(report);
  }

  const wsServer = getDoudianWsServer({ port: bridgePort });
  const { startBridgeWsServer } = require('../../../scripts/lib/auto-verify-utils');
  const wsStarted = await startBridgeWsServer(wsServer, report);
  if (!wsStarted) {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeReport(report);
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

  console.log(
    `[抖店桥] reply-editor ${mode}${guidedMode ? ' guided' : ''} 已启动，超时 ${timeoutMinutes} 分钟`
  );
  if (guidedMode) {
    console.log('[抖店桥] guided 模式: IM 就绪后将持续等待您手动点开买家会话...');
  } else {
    console.log('[抖店桥] 请在 IM 打开后手动选中买家会话');
  }
  await sleep(3000);

  const imResult = await runDoudianImWorkspacePhase({
    wsServer,
    bridgeTracker: tracker,
    report,
    timeoutMs: DEFAULT_IM_WAIT_MS,
    openIfMissing: true,
    onTick: () => {
      applyShopStats(stdoutLines);
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
    report.warnings.push('IM workspace 未在时限内打开');
    report.nextActions = [
      '确认 patch 已应用到测试目录并重启抖店',
      '运行 npm run doudian:auto-verify-im',
    ];
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    try {
      child.unref();
    } catch {
      // ignore
    }
    return sanitizeReport(report);
  }

  waitStarted = Date.now();
  const timeoutMs = timeoutMinutes * 60 * 1000;

  while (!completed && Date.now() - waitStarted < timeoutMs) {
    applyBridgeClassificationToReport(report, tracker);
    applyIntegrityWarningsToReport(report, integrityWarnings);
    tracker.refreshShopStats();
    applyShopStats(stdoutLines);
    report.imBridgeSeen = Math.max(
      report.imBridgeSeen || 0,
      tracker.hasImBridge() ? 1 : 0,
      report.imOpenSuccess ? 1 : 0
    );

    const imBridgeIds = tracker.getImBridgeIds();
    for (const id of imBridgeIds) {
      if (!shopInfoSent.has(id)) {
        wsServer.sendDebugCommand(id, 'debug.get_shop_info', {});
        shopInfoSent.add(id);
      }
    }

    const resolved = refreshConversationSelectionFromHints();
    announceSelection(resolved);

    if (Date.now() - lastHintsAt >= HINTS_INTERVAL_MS) {
      for (const id of imBridgeIds) {
        wsServer.sendDebugCommand(id, 'debug.get_conversation_hints', {});
      }
      lastHintsAt = Date.now();
    }

    if (
      selectionAnnounced &&
      report.activeShopResolved &&
      Date.now() - lastInspectAt >= HINTS_INTERVAL_MS
    ) {
      for (const id of imBridgeIds) {
        wsServer.sendDebugCommand(id, 'debug.inspect_reply_editor', {});
      }
      lastInspectAt = Date.now();
    }

    if (pendingImmediateInspect && report.activeShopResolved) {
      for (const id of imBridgeIds) {
        wsServer.sendDebugCommand(id, 'debug.inspect_reply_editor', {});
        if (mode === 'fill') {
          tryFillDraft(wsServer, imBridgeIds);
        }
      }
      pendingImmediateInspect = false;
      lastInspectAt = Date.now();
    } else if (
      mode === 'fill' &&
      selectionAnnounced &&
      report.activeShopResolved &&
      !fillAttempted &&
      !completed
    ) {
      tryFillDraft(wsServer, imBridgeIds);
    }

    if (Date.now() - lastBriefingAt >= GUIDED_BRIEFING_MS) {
      if (guidedMode) {
        printGuidedReplyEditorBriefing(report);
      } else {
        printReplyEditorBriefing(report);
      }
      lastBriefingAt = Date.now();
    }

    await sleep(1000);
  }

  finalizeOutcome();

  report.imBridgeSeen = Math.max(
    report.imBridgeSeen || 0,
    tracker.hasImBridge() ? 1 : 0,
    report.imOpenSuccess ? 1 : 0
  );
  applyBridgeClassificationToReport(report, tracker);

  if (report.success && mode === 'verify') {
    report.nextActions = [
      guidedMode
        ? '引导式输入框检测通过，可运行 npm run doudian:fill-reply-draft-guided 填入草稿'
        : '输入框与发送按钮检测通过，可运行 npm run doudian:fill-reply-draft 填入草稿',
      '本阶段禁止自动点击发送',
    ];
  } else if (report.success && mode === 'fill') {
    report.nextActions = [
      '草稿已填入输入框，请人工审核后手动点击发送',
      'draft status 保持 draft_only，未调用任何发送接口',
    ];
  }

  attachDraftStatusAfter();
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;

  try {
    child.unref();
  } catch {
    // ignore
  }

  return sanitizeReport(report);
}

function sanitizeReport(report) {
  return {
    ...report,
    conversationId: maskIdForReport(report.conversationId),
    buyerId: maskIdForReport(report.buyerId),
  };
}

module.exports = {
  runReplyEditorSession,
  buildReplyEditorTextReport,
  buildFillDraftTextReport,
  buildGuidedReplyEditorTextReport,
  buildGuidedFillDraftTextReport,
  printReplyEditorBriefing,
  printGuidedReplyEditorBriefing,
  getGuidedReplyEditorStatus,
  isActiveShopResolved,
  parseTimeoutMinutes,
  DEFAULT_TIMEOUT_MINUTES,
  EDITOR_CONFIDENCE_THRESHOLD,
  matchDraftToConversation,
  analyzeReplyEditorInspection,
};
