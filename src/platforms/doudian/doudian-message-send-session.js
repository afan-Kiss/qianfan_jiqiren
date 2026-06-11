const path = require('path');
const { spawn } = require('child_process');
const { getDoudianWsServer } = require('./doudian-ws-server');
const { DOUDIAN_EVENTS } = require('./doudian-types');
const { getDoudianConfig } = require('../../shared/config');
const {
  insertOutboundMessage,
  updateOutboundMessage,
  getLatestOutboundMessage,
  closeDb,
} = require('./doudian-data-store');
const {
  analyzeReplyEditorInspection,
  EDITOR_CONFIDENCE_THRESHOLD,
} = require('./doudian-reply-editor-detector');
const { pickFirst } = require('./doudian-shop-utils');
const { parseStdoutBusinessSignals, redactStdoutLine } = require('./doudian-stdout-business-parser');
const {
  buildShopStatsSnapshot,
  applyShopStatsToTarget,
} = require('./doudian-shop-stats-aggregator');
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
const {
  ShopBridgeTracker,
  LISTEN_WATCH_TYPES,
} = require('../../../scripts/lib/shop-bridge-tracker');

const REQUIRED_SEND_SHOP_ID = '263636465';
const DEFAULT_TIMEOUT_MINUTES = 15;
const BRIEFING_MS = 5000;
const HINTS_INTERVAL_MS = 5000;
const VERIFY_CHAT_TIMEOUT_MS = 15000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseSendMessageCliArgs(argv = []) {
  let buyerName = '一只小青蛙';
  let text = '';
  let confirmSend = false;
  let timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--buyer-name' && argv[i + 1]) buyerName = String(argv[++i]);
    else if (argv[i] === '--text' && argv[i + 1]) text = String(argv[++i]);
    else if (argv[i] === '--confirm-send') confirmSend = true;
    else if (argv[i] === '--timeout-minutes' && argv[i + 1]) {
      timeoutMinutes = Math.max(1, Number(argv[++i]) || DEFAULT_TIMEOUT_MINUTES);
    }
  }
  return { buyerName, text, confirmSend, timeoutMinutes };
}

function maskIdForReport(value = '') {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 8) return `${s.slice(0, 2)}***`;
  return `${s.slice(0, 8)}***`;
}

function maskTextForReport(text = '', maxLen = 200) {
  return String(text || '')
    .slice(0, maxLen)
    .replace(/1\d{10}/g, (m) => `${m.slice(0, 3)}****${m.slice(-4)}`);
}

function matchesTargetBuyerName(targetBuyerName, currentBuyerName, domTextSamples = []) {
  const target = String(targetBuyerName || '').trim();
  if (!target) return false;
  const current = String(currentBuyerName || '').trim();
  if (current && current.includes(target)) return true;
  for (const sample of domTextSamples) {
    if (String(sample || '').includes(target)) return true;
  }
  return false;
}

function isActiveShopResolved(report) {
  const shop = (report.activeImShops || [])[0] || report.activeShop || {};
  return Boolean(String(shop.shopId || '').trim());
}

function getActiveShopContext(report) {
  const shop = (report.activeImShops || [])[0] || report.activeShop || {};
  return {
    shopId: pickFirst(shop.shopId, report.activeShop?.shopId),
    shopName: pickFirst(shop.shopName, report.activeShop?.shopName),
  };
}

function buildSendMessageTextReport(report) {
  const lines = [];
  lines.push('=== 抖店发送消息报告 ===');
  lines.push(`时间: ${report.finishedAt || new Date().toISOString()}`);
  lines.push(`结果: ${report.success ? '成功' : '失败'}`);
  lines.push(`reason: ${report.reason || ''}`);
  lines.push(`targetBuyerName: ${report.targetBuyerName || ''}`);
  lines.push(`currentBuyerName: ${report.currentBuyerName || ''}`);
  lines.push(`shopId: ${report.shopId || ''}`);
  lines.push(`shopName: ${report.shopName || ''}`);
  lines.push(`conversationId: ${report.conversationId || ''}`);
  lines.push(`buyerId: ${report.buyerId || ''}`);
  lines.push(`confirmSend: ${report.confirmSend}`);
  lines.push(`editorFound: ${report.editorFound}`);
  lines.push(`sendButtonFound: ${report.sendButtonFound}`);
  lines.push(`sendButtonEnabled: ${report.sendButtonEnabled}`);
  lines.push(`filled: ${report.filled}`);
  lines.push(`fillVerified: ${report.fillVerified}`);
  lines.push(`sendClicked: ${report.sendClicked}`);
  lines.push(`sent: ${report.sent}`);
  lines.push(`verifiedInChat: ${report.verifiedInChat}`);
  lines.push(`outboundMessageId: ${report.outboundMessageId || 0}`);
  if (report.runLock) {
    lines.push(
      `runLock: acquired=${report.runLock.acquired} forceKill=${report.runLock.forceKill || false}`
    );
  }
  if (report.portGuard) {
    lines.push(
      `portGuard: port=${report.portGuard.port} success=${report.portGuard.success} reason=${report.portGuard.reason || ''}`
    );
  }
  if (report.warnings?.length) {
    lines.push('Warnings:');
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  if (report.errors?.length) {
    lines.push('Errors:');
    for (const e of report.errors) lines.push(`- ${e}`);
  }
  if (report.nextActions?.length) {
    lines.push('Next actions:');
    for (const a of report.nextActions) lines.push(`- ${a}`);
  }
  return lines;
}

function printSendBriefing(report) {
  const active = getActiveShopContext(report);
  console.log('[抖店桥] send-message-to-buyer:');
  console.log(`targetBuyerName: ${report.targetBuyerName || ''}`);
  console.log(`currentBuyerName: ${report.currentBuyerName || ''}`);
  console.log(`activeShop: ${active.shopId || ''} / ${active.shopName || ''}`);
  console.log(`selectedConversationDetected: ${report.selectedConversationDetected}`);
  console.log(`editorFound: ${report.editorFound}`);
  console.log(`sendButtonFound: ${report.sendButtonFound}`);
  if (!report.confirmSend) {
    console.log('状态: 缺少 --confirm-send，不会发送');
    return;
  }
  if (!report.selectedConversationDetected) {
    console.log(`状态: 请在 IM 中选中买家「${report.targetBuyerName || ''}」会话`);
    return;
  }
  if (report.reason === 'target_buyer_mismatch') {
    console.log(`状态: 当前会话不是「${report.targetBuyerName || ''}」，请切换买家`);
    return;
  }
  if (report.sent && report.verifiedInChat) {
    console.log('状态: 消息已发送并在聊天区确认');
    return;
  }
  if (report.sent && !report.verifiedInChat) {
    console.log('状态: 已点击发送，但聊天区尚未确认');
    return;
  }
  console.log('状态: 等待门禁通过并发送...');
}

function evaluateSendGates(report, options = {}) {
  if (!options.confirmSend) {
    return { ok: false, reason: 'missing_confirm_send' };
  }
  if (!String(options.text || '').trim()) {
    return { ok: false, reason: 'empty_text' };
  }
  if ((report.imBridgeSeen || 0) < 1) {
    return { ok: false, reason: 'im_bridge_not_seen' };
  }
  if (!report.activeShopResolved) {
    return { ok: false, reason: 'active_shop_not_resolved' };
  }
  const active = getActiveShopContext(report);
  if (String(active.shopId || '') !== REQUIRED_SEND_SHOP_ID) {
    return { ok: false, reason: 'shop_id_mismatch' };
  }
  if (!report.selectedConversationDetected) {
    return { ok: false, reason: 'no_selected_conversation' };
  }
  if (
    !matchesTargetBuyerName(
      report.targetBuyerName,
      report.currentBuyerName || report.buyerName,
      report.domTextSamples || []
    )
  ) {
    return { ok: false, reason: 'target_buyer_mismatch' };
  }
  if (!report.editorFound || (report.editorConfidence || 0) < EDITOR_CONFIDENCE_THRESHOLD) {
    return { ok: false, reason: 'reply_editor_not_found' };
  }
  if (!report.sendButtonFound) {
    return { ok: false, reason: 'send_button_not_found' };
  }
  if (!report.sendButtonEnabled) {
    return { ok: false, reason: 'send_button_disabled' };
  }
  return { ok: true, reason: '' };
}

function buildMockEditorPayload(overrides = {}) {
  return {
    viewport: { width: 1400, height: 900 },
    editorCandidates: overrides.editorCandidates || [
      {
        selectorPath: 'div.composer > textarea',
        editorType: 'textarea',
        rect: { x: 340, y: 780, width: 520, height: 80 },
        score: 70,
      },
    ],
    sendButtonCandidates: overrides.sendButtonCandidates || [
      {
        selectorPath: 'div.composer > button.send',
        text: '发送',
        rect: { x: 880, y: 800, width: 64, height: 32 },
        sendButtonEnabled: true,
        score: 60,
      },
    ],
    buyerName: overrides.buyerName || '一只小青蛙',
    buyerId: overrides.buyerId || 'buyer_qingwa_001',
    conversationId: overrides.conversationId || `doudian:${REQUIRED_SEND_SHOP_ID}:buyer:buyer_qingwa_001`,
    selectedConversation: {
      buyerName: overrides.buyerName || '一只小青蛙',
      buyerId: overrides.buyerId || 'buyer_fanfan_001',
      conversationId:
        overrides.conversationId || `doudian:${REQUIRED_SEND_SHOP_ID}:buyer:buyer_qingwa_001`,
    },
  };
}

async function runMessageSendSession(options = {}) {
  const cfg = getDoudianConfig();
  const knownShops = cfg.knownShops || [];
  const bridgePort = Number(options.bridgePort || cfg.bridgePort || 19527);
  const installDir = options.installDir;
  const exePath = installDir ? path.join(installDir, 'doudian.exe') : '';
  const mockMode = Boolean(options.mockMode);
  const mockScenario = options.mockScenario || '';
  const timeoutMinutes = Number(options.timeoutMinutes || DEFAULT_TIMEOUT_MINUTES);
  const targetBuyerName = String(options.targetBuyerName || '一只小青蛙');
  const text = String(options.text || '');
  const confirmSend = Boolean(options.confirmSend);
  const startedAt = Date.now();

  const report = {
    success: false,
    reason: '',
    targetBuyerName,
    currentBuyerName: '',
    shopId: '',
    shopName: '',
    conversationId: '',
    buyerId: '',
    text: maskTextForReport(text),
    confirmSend,
    imBridgeSeen: 0,
    imOpenAttempts: [],
    imOpenSuccess: false,
    activeShopResolved: false,
    activeShop: { shopId: '', shopName: '' },
    selectedConversationDetected: false,
    editorFound: false,
    editorConfidence: 0,
    sendButtonFound: false,
    sendButtonEnabled: false,
    filled: false,
    fillVerified: false,
    sendClicked: false,
    sent: false,
    verifiedInChat: false,
    outboundMessageId: 0,
    domTextSamples: [],
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

  if (!confirmSend) {
    report.reason = 'missing_confirm_send';
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    const blocked = insertOutboundMessage({
      shopId: REQUIRED_SEND_SHOP_ID,
      text,
      buyerName: targetBuyerName,
      status: 'blocked',
      sendMethod: 'ui',
      verifiedInChat: false,
      errorReason: report.reason,
    });
    report.outboundMessageId = blocked.id;
    return sanitizeSendReport(report);
  }

  if (mockMode) {
    return runMockMessageSendSession(report, {
      mockScenario,
      text,
      confirmSend,
      targetBuyerName,
      startedAt,
    });
  }

  const tracker = new ShopBridgeTracker({ knownShops });
  const stdoutLines = [];
  let integrityWarnings = [];
  let latestDomHints = {};
  let shopIdentityHints = [];
  let memoryCacheHints = [];
  let sendAttempted = false;
  let sendCompleted = false;
  let lastHintsAt = 0;
  let lastInspectAt = 0;
  let lastBriefingAt = 0;
  let waitStarted = 0;
  let pendingSendResult = null;

  function applyShopStats(stdoutChunkLines = stdoutLines) {
    const stdoutSignal = parseStdoutBusinessSignals(stdoutChunkLines);
    const snapshot = buildShopStatsSnapshot({
      tracker,
      stdoutSignal,
      knownShops,
      shopIdentityHints,
      memoryCacheHints,
    });
    applyShopStatsToTarget(report, snapshot);
    report.imBridgeSeen = Math.max(
      report.imBridgeSeen || 0,
      snapshot.imBridgeSeen || 0,
      tracker.hasImBridge?.() ? 1 : 0,
      report.imOpenSuccess ? 1 : 0
    );
    report.activeShopResolved = isActiveShopResolved(report);
    const active = getActiveShopContext(report);
    report.shopId = active.shopId || '';
    report.shopName = active.shopName || '';
  }

  function refreshConversationSelectionFromHints() {
    const activeShop = getActiveShopContext(report);
    const resolved = resolveSelectedConversation(
      report,
      { domHints: latestDomHints, shopId: activeShop.shopId },
      activeShop
    );
    applySelectedConversationToReport(report, resolved);
    report.currentBuyerName = pickFirst(
      resolved.buyerName,
      latestDomHints.buyerName,
      latestDomHints.chatHeaderBuyerName,
      report.buyerName
    );
    report.selectedConversationDetected = isConversationSelected(resolved);
    if (!report.conversationId && resolved.buyerId && activeShop.shopId) {
      report.conversationId = buildFallbackConversationId(activeShop.shopId, resolved.buyerId);
    }
    return resolved;
  }

  function applyEditorInspection(payload = {}) {
    const analysis = analyzeReplyEditorInspection(payload);
    report.editorFound = analysis.editorFound;
    report.editorConfidence = analysis.editorConfidence;
    report.sendButtonFound = analysis.sendButtonFound;
    report.sendButtonEnabled = analysis.sendButtonEnabled !== false;
    const hints = payload.selectedConversation || payload.hints || {};
    if (payload.conversationId || payload.buyerId || hints.buyerName) {
      latestDomHints = {
        ...latestDomHints,
        conversationId: pickFirst(payload.conversationId, hints.conversationId, latestDomHints.conversationId),
        buyerId: pickFirst(payload.buyerId, hints.buyerId, latestDomHints.buyerId),
        buyerName: pickFirst(payload.buyerName, hints.buyerName, latestDomHints.buyerName),
        chatHeaderBuyerName: pickFirst(hints.chatHeaderBuyerName, hints.buyerName, latestDomHints.chatHeaderBuyerName),
      };
      refreshConversationSelectionFromHints();
    }
  }

  function applySendResult(payload = {}) {
    sendCompleted = true;
    report.filled = Boolean(payload.filled);
    report.fillVerified = Boolean(payload.fillVerified);
    report.sendClicked = Boolean(payload.sendClicked);
    report.sent = Boolean(payload.sent);
    report.verifiedInChat = Boolean(payload.verifiedInChat);
    report.editorFound = Boolean(payload.editorFound || report.editorFound);
    report.sendButtonFound = Boolean(payload.sendButtonFound || report.sendButtonFound);
    report.sendButtonEnabled = payload.sendButtonEnabled !== false;
    report.reason = String(payload.reason || report.reason || '');
    report.success = Boolean(payload.success);
    if (payload.buyerName) report.currentBuyerName = payload.buyerName;
  }

  function handleEnvelope(envelope) {
    if (envelope.type === 'bridge.open_im_attempt') {
      attachOpenImAttemptResponse(report.imOpenAttempts, envelope);
    }

    const title = envelope.payload?.title || envelope.payload?.info?.title || '';
    integrityWarnings = scanWindowTitle(title, integrityWarnings);

    if (LISTEN_WATCH_TYPES.has(envelope.type)) {
      tracker.recordEvent(envelope);
    }

    const p = envelope.payload || {};

    if (envelope.type === DOUDIAN_EVENTS.SHOP_IDENTITY_RESOLVED) {
      shopIdentityHints.push({
        shopId: pickFirst(p.shopId, p.shopInfo?.shopId),
        shopName: pickFirst(p.shopName, p.shopInfo?.shopName),
        bridgeId: envelope.bridgeId,
      });
    }
    if (envelope.type === DOUDIAN_EVENTS.MEMORY_CACHE_CANDIDATE) {
      memoryCacheHints.push({
        shopId: pickFirst(p.shopId, p.shopInfo?.shopId),
        shopName: pickFirst(p.shopName, p.shopInfo?.shopName),
        bridgeId: envelope.bridgeId,
      });
    }
    if (envelope.type === DOUDIAN_EVENTS.CHAT_CONVERSATION_HINTS) {
      const hints = p.hints || p.selectedConversation || {};
      if (hints && Object.keys(hints).length) {
        latestDomHints = { ...latestDomHints, ...hints };
        refreshConversationSelectionFromHints();
      }
    }
    if (envelope.type === DOUDIAN_EVENTS.CHAT_DOM_INSPECTION) {
      const samples = Array.isArray(p.textSamples) ? p.textSamples : [];
      if (samples.length) report.domTextSamples = samples.slice(0, 20);
    }
    if (envelope.type === DOUDIAN_EVENTS.REPLY_EDITOR_INSPECTION) {
      applyEditorInspection(p);
    }
    if (envelope.type === DOUDIAN_EVENTS.MESSAGE_SEND_RESULT) {
      pendingSendResult = p;
      applySendResult(p);
    }
  }

  function trySend(wsServer, imBridgeIds) {
    if (sendAttempted || sendCompleted) return;
    const gates = evaluateSendGates(report, { confirmSend, text, targetBuyerName });
    if (!gates.ok) {
      if (gates.reason === 'target_buyer_mismatch') {
        report.reason = gates.reason;
      }
      return;
    }
    sendAttempted = true;
    console.log(`[抖店桥] 门禁通过，向买家「${targetBuyerName}」发送消息（UI 点击）`);
    for (const id of imBridgeIds) {
      wsServer.sendDebugCommand(id, 'debug.send_message_to_buyer', {
        text,
        confirmSend: true,
        targetBuyerName,
      });
    }
  }

  const wsServer = getDoudianWsServer({ port: bridgePort });
  const { startBridgeWsServer } = require('../../../scripts/lib/auto-verify-utils');
  const wsStarted = await startBridgeWsServer(wsServer, report);
  if (!wsStarted) {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeSendReport(report);
  }
  wsServer.on('*', handleEnvelope);

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

  console.log(`[抖店桥] send-message-to-buyer 已启动，目标买家「${targetBuyerName}」，超时 ${timeoutMinutes} 分钟`);
  console.log('[抖店桥] 请确认 IM 已选中目标买家会话');
  await sleep(3000);

  const imResult = await runDoudianImWorkspacePhase({
    wsServer,
    bridgeTracker: tracker,
    report,
    timeoutMs: DEFAULT_IM_WAIT_MS,
    openIfMissing: true,
    onTick: () => {
      applyShopStats(stdoutLines);
      applyIntegrityWarningsToReport(report, integrityWarnings);
    },
    logPrefix: '[抖店桥]',
  });

  applyIntegrityWarningsToReport(report, integrityWarnings);
  if (imResult.imBridgeSeen !== 1) {
    report.reason = 'im_workspace_not_opened';
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    const blocked = insertOutboundMessage({
      shopId: report.shopId || REQUIRED_SEND_SHOP_ID,
      shopName: report.shopName,
      text,
      buyerName: targetBuyerName,
      status: 'blocked',
      errorReason: report.reason,
    });
    report.outboundMessageId = blocked.id;
    return sanitizeSendReport(report);
  }

  waitStarted = Date.now();
  const timeoutMs = timeoutMinutes * 60 * 1000;
  let outboundRow = insertOutboundMessage({
    shopId: REQUIRED_SEND_SHOP_ID,
    text,
    buyerName: targetBuyerName,
    status: 'pending',
    sendMethod: 'ui',
  });
  report.outboundMessageId = outboundRow.id;

  while (!sendCompleted && Date.now() - waitStarted < timeoutMs) {
    applyShopStats(stdoutLines);
    applyIntegrityWarningsToReport(report, integrityWarnings);
    tracker.refreshShopStats();
    report.imBridgeSeen = Math.max(report.imBridgeSeen || 0, tracker.hasImBridge() ? 1 : 0);

    const imBridgeIds = tracker.getImBridgeIds();
    refreshConversationSelectionFromHints();

    if (Date.now() - lastHintsAt >= HINTS_INTERVAL_MS) {
      for (const id of imBridgeIds) {
        wsServer.sendDebugCommand(id, 'debug.get_conversation_hints', {});
        wsServer.sendDebugCommand(id, 'debug.inspect_chat_dom', {});
      }
      lastHintsAt = Date.now();
    }

    if (Date.now() - lastInspectAt >= HINTS_INTERVAL_MS) {
      for (const id of imBridgeIds) {
        wsServer.sendDebugCommand(id, 'debug.inspect_reply_editor', {});
      }
      lastInspectAt = Date.now();
    }

    if (!sendAttempted) {
      trySend(wsServer, imBridgeIds);
    } else if (sendAttempted && !sendCompleted) {
      await sleep(500);
    }

    if (Date.now() - lastBriefingAt >= BRIEFING_MS) {
      printSendBriefing(report);
      lastBriefingAt = Date.now();
    }
    await sleep(1000);
  }

  if (!sendCompleted && sendAttempted) {
    const verifyDeadline = Date.now() + VERIFY_CHAT_TIMEOUT_MS;
    while (!sendCompleted && Date.now() < verifyDeadline) {
      await sleep(500);
    }
  }

  if (!sendCompleted) {
    const gates = evaluateSendGates(report, { confirmSend, text, targetBuyerName });
    report.reason = gates.reason || 'send_timeout';
    report.success = false;
    updateOutboundMessage(report.outboundMessageId, {
      status: 'failed',
      errorReason: report.reason,
    });
  } else {
    const status = report.verifiedInChat ? 'sent' : report.sent ? 'sent_unverified' : 'failed';
    updateOutboundMessage(report.outboundMessageId, {
      status,
      verifiedInChat: report.verifiedInChat,
      errorReason: report.success ? '' : report.reason,
    });
    if (report.success) {
      report.nextActions = ['消息已发送并在聊天区确认', '可在 platform_outbound_messages 查看发送记录'];
    } else if (report.sent) {
      report.nextActions = ['已点击发送但聊天区未确认，请人工检查 IM 窗口'];
    }
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  try {
    child.unref();
  } catch {
    // ignore
  }
  return sanitizeSendReport(report);
}

function runMockMessageSendSession(report, ctx) {
  const { mockScenario, text, confirmSend, targetBuyerName, startedAt } = ctx;
  const shopInfo = { shopId: REQUIRED_SEND_SHOP_ID, shopName: 'XY祥钰珠宝' };
  report.imBridgeSeen = 1;
  report.activeShop = shopInfo;
  report.activeShopResolved = true;
  report.shopId = shopInfo.shopId;
  report.shopName = shopInfo.shopName;

  const outbound = insertOutboundMessage({
    shopId: shopInfo.shopId,
    shopName: shopInfo.shopName,
    text,
    buyerName: targetBuyerName,
    status: 'pending',
    sendMethod: 'ui',
  });
  report.outboundMessageId = outbound.id;

  if (mockScenario === 'buyer_mismatch') {
    report.selectedConversationDetected = true;
    report.currentBuyerName = '其他买家';
    report.buyerName = '其他买家';
    report.reason = 'target_buyer_mismatch';
    updateOutboundMessage(report.outboundMessageId, { status: 'blocked', errorReason: report.reason });
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeSendReport(report);
  }

  if (mockScenario === 'shop_mismatch') {
    report.activeShop = { shopId: '999999999', shopName: '其他店' };
    report.shopId = '999999999';
    report.selectedConversationDetected = true;
    report.currentBuyerName = targetBuyerName;
    report.reason = 'shop_id_mismatch';
    updateOutboundMessage(report.outboundMessageId, { status: 'blocked', errorReason: report.reason });
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeSendReport(report);
  }

  const payload =
    mockScenario === 'editor_missing'
      ? buildMockEditorPayload({ editorCandidates: [], sendButtonCandidates: [] })
      : mockScenario === 'send_button_missing'
        ? buildMockEditorPayload({ sendButtonCandidates: [] })
        : buildMockEditorPayload({ buyerName: targetBuyerName });

  applyEditorInspectionMock(report, payload);

  if (mockScenario === 'editor_missing') {
    report.reason = 'reply_editor_not_found';
    updateOutboundMessage(report.outboundMessageId, { status: 'blocked', errorReason: report.reason });
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeSendReport(report);
  }
  if (mockScenario === 'send_button_missing') {
    report.reason = 'send_button_not_found';
    updateOutboundMessage(report.outboundMessageId, { status: 'blocked', errorReason: report.reason });
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeSendReport(report);
  }

  report.selectedConversationDetected = true;
  report.currentBuyerName = targetBuyerName;
  report.filled = true;
  report.fillVerified = true;
  report.sendClicked = true;
  report.sent = true;
  report.verifiedInChat = mockScenario !== 'sent_unverified';
  report.success = report.verifiedInChat;
  report.reason = report.success ? 'message_sent_and_verified' : 'sent_but_not_verified';

  updateOutboundMessage(report.outboundMessageId, {
    status: report.success ? 'sent' : 'sent_unverified',
    verifiedInChat: report.verifiedInChat,
    errorReason: report.success ? '' : report.reason,
  });

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  return sanitizeSendReport(report);
}

function applyEditorInspectionMock(report, payload) {
  const analysis = analyzeReplyEditorInspection(payload);
  report.editorFound = analysis.editorFound;
  report.editorConfidence = analysis.editorConfidence;
  report.sendButtonFound = analysis.sendButtonFound;
  report.sendButtonEnabled = analysis.sendButtonEnabled !== false;
  report.buyerId = payload.buyerId || '';
  report.conversationId = payload.conversationId || '';
  report.currentBuyerName = payload.buyerName || '';
  report.buyerName = payload.buyerName || '';
}

function sanitizeSendReport(report) {
  return {
    ...report,
    conversationId: maskIdForReport(report.conversationId),
    buyerId: maskIdForReport(report.buyerId),
    text: maskTextForReport(report.text),
  };
}

module.exports = {
  runMessageSendSession,
  parseSendMessageCliArgs,
  matchesTargetBuyerName,
  buildSendMessageTextReport,
  evaluateSendGates,
  REQUIRED_SEND_SHOP_ID,
  getLatestOutboundMessage,
  closeDb,
};
