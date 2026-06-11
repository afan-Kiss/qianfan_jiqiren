const path = require('path');
const fs = require('fs');
const { getDoudianConfig } = require('../../shared/config');
const { DOUDIAN_EVENTS } = require('./doudian-types');
const { DoudianDedupe } = require('./doudian-dedupe');
const { DoudianBusinessPipeline } = require('./doudian-business-pipeline');
const {
  insertMessage,
  insertOutboundMessage,
  updateOutboundMessage,
  closeDb,
} = require('./doudian-data-store');
const {
  analyzeReplyEditorInspection,
  EDITOR_CONFIDENCE_THRESHOLD,
} = require('./doudian-reply-editor-detector');
const {
  applyMergedSourcesToReport,
  evaluateSendAllowance,
  hasTrustedBuyerIdentity,
} = require('./doudian-conversation-sources-resolver');
const {
  analyzeDomInspection,
  bubblesToHistoryItems,
} = require('./doudian-chat-dom-trust');
const { evaluateHistoryTrust } = require('./doudian-history-validation');
const { isConversationSelected } = require('./doudian-conversation-resolver');
const { maskMessageForReport, pickFirst } = require('./doudian-shop-utils');
const { maskTextForReport } = require('./doudian-conversation-list-parser');
const {
  createImLiveContext,
  bootstrapImLiveClient,
  sanitizeLiveReport,
  sleep,
} = require('./doudian-im-live-shared');
const { applyIntegrityWarningsToReport } = require('./doudian-integrity-warning-monitor');
const {
  GUIDED_POLL_MS,
  GUIDED_BRIEFING_MS,
  GUIDED_DEFAULT_TIMEOUT_MINUTES,
  isGuidedConversationReady,
  printGuidedConversationBriefing,
  applyEmptyStateFlags,
} = require('./doudian-conversation-guided-shared');
function evaluateMessageFlowSendGates(report = {}, options = {}) {
  if (!options.confirmSend) return { ok: false, reason: 'missing_confirm_send' };
  if (!String(options.text || '').trim()) return { ok: false, reason: 'empty_text' };
  if ((report.imBridgeSeen || 0) < 1) return { ok: false, reason: 'im_bridge_not_seen' };
  if (!report.activeShopResolved) return { ok: false, reason: 'active_shop_not_resolved' };
  if (
    !report.historyCaptured &&
    !report.selectedConversationDetected &&
    !report.selectionEverDetected
  ) {
    return { ok: false, reason: 'no_selected_conversation' };
  }
  if (!report.editorFound || (report.editorConfidence || 0) < EDITOR_CONFIDENCE_THRESHOLD) {
    return { ok: false, reason: 'reply_editor_not_found' };
  }
  return { ok: true, reason: '' };
}

function applyEditorInspectionToReport(report, payload = {}, ctx) {
  const analysis = analyzeReplyEditorInspection(payload);
  report.editorFound = analysis.editorFound;
  report.editorConfidence = analysis.editorConfidence;
  report.sendButtonFound = analysis.sendButtonFound;
  report.sendButtonEnabled = analysis.sendButtonEnabled !== false;
  const hints = payload.selectedConversation || payload.hints || {};
  if (payload.conversationId || payload.buyerId || hints.buyerName) {
    ctx.latestDomHints = {
      ...ctx.latestDomHints,
      conversationId: pickFirst(payload.conversationId, hints.conversationId, ctx.latestDomHints.conversationId),
      buyerId: pickFirst(payload.buyerId, hints.buyerId, ctx.latestDomHints.buyerId),
      buyerName: pickFirst(payload.buyerName, hints.buyerName, ctx.latestDomHints.buyerName),
      chatHeaderBuyerName: pickFirst(hints.chatHeaderBuyerName, hints.buyerName, ctx.latestDomHints.chatHeaderBuyerName),
    };
    ctx.refreshConversationSelectionFromHints();
  }
  if (isGuidedConversationReady(report)) {
    report.selectionEverDetected = true;
  }
}

function applySendResult(report, payload = {}) {
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
  if (payload.buyerName) report.buyerName = payload.buyerName;
  if (payload.buyerId) report.buyerId = payload.buyerId;
  if (payload.conversationId) report.conversationId = payload.conversationId;
}

const HISTORY_POLL_MS = 5000;
const LISTEN_DEFAULT_MINUTES = 5;
const SEND_WARMUP_MS = 8000;
const VERIFY_CHAT_TIMEOUT_MS = 15000;

const FLOW_PHASES = ['history', 'listen', 'send'];

function parseMessageFlowCliArgs(argv = []) {
  let text = '';
  let confirmSend = false;
  let skipSend = false;
  let skipListen = false;
  let timeoutMinutes = GUIDED_DEFAULT_TIMEOUT_MINUTES;
  let listenMinutes = LISTEN_DEFAULT_MINUTES;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--text' && argv[i + 1]) text = String(argv[++i]);
    else if (argv[i] === '--confirm-send') confirmSend = true;
    else if (argv[i] === '--skip-send') skipSend = true;
    else if (argv[i] === '--skip-listen') skipListen = true;
    else if (argv[i] === '--timeout-minutes' && argv[i + 1]) {
      timeoutMinutes = Math.max(1, Number(argv[++i]) || GUIDED_DEFAULT_TIMEOUT_MINUTES);
    } else if (argv[i] === '--listen-minutes' && argv[i + 1]) {
      listenMinutes = Math.max(1, Number(argv[++i]) || LISTEN_DEFAULT_MINUTES);
    }
  }
  return { text, confirmSend, skipSend, skipListen, timeoutMinutes, listenMinutes };
}

function directionLabel(direction = '') {
  const d = String(direction || '').toLowerCase();
  if (d === 'buyer' || d === 'inbound') return '【买家】';
  if (d === 'seller' || d === 'outbound') return '【商家】';
  return '【未知】';
}

function printHistoryMessages(messages = []) {
  console.log('\n=== 历史消息（收发内容） ===');
  if (!messages.length) {
    console.log('（暂无历史消息）');
    return;
  }
  messages.forEach((m, i) => {
    console.log(`${i + 1}. ${directionLabel(m.direction)} ${m.text || ''}`);
  });
}

function printConversationList(conversations = []) {
  console.log('\n=== 当前买家列表 ===');
  const seen = new Set();
  let idx = 0;
  for (const row of conversations) {
    const name = String(row.buyerName || '').trim();
    if (!name) continue;
    const key = `${name}:${row.buyerId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    idx += 1;
    const id = row.buyerId ? `${String(row.buyerId).slice(0, 4)}***` : '(无ID)';
    console.log(`${idx}. ${name}  buyerId=${id}  最近: ${row.lastMessage || '-'}  ${row.timeText || ''}`);
  }
  if (!idx) console.log('（列表为空或未识别到买家昵称）');
}

function printLiveMessage(msg = {}) {
  const label = directionLabel(msg.direction);
  const buyer = msg.buyerName ? ` ${msg.buyerName}` : '';
  console.log(`[实时] ${label}${buyer}: ${msg.text || ''}`);
}

function buildMessageFlowTextReport(report) {
  const lines = [];
  lines.push('=== 抖店消息流 guided 报告 ===');
  lines.push(`时间: ${report.finishedAt || new Date().toISOString()}`);
  lines.push(`结果: ${report.success ? '成功' : '失败/未完成'}`);
  lines.push(`reason: ${report.reason || ''}`);
  lines.push(`phase: ${report.phase || ''}`);
  lines.push(`shopId: ${report.shopId || ''}`);
  lines.push(`shopName: ${report.shopName || ''}`);
  lines.push(`buyerId: ${report.buyerId || ''}`);
  lines.push(`buyerName: ${report.buyerName || ''}`);
  lines.push(`historyMessageCount: ${report.historyMessageCount || 0}`);
  lines.push(`buyerHistoryCount: ${report.buyerHistoryCount || 0}`);
  lines.push(`sellerHistoryCount: ${report.sellerHistoryCount || 0}`);
  lines.push(`liveMessageCount: ${report.liveMessageCount || 0}`);
  lines.push(`liveInboundCount: ${report.liveInboundCount || 0}`);
  lines.push(`liveOutboundCount: ${report.liveOutboundCount || 0}`);
  lines.push(`conversationListCount: ${report.conversationListCount || 0}`);
  lines.push(`sent: ${report.sent || false}`);
  lines.push(`verifiedInChat: ${report.verifiedInChat || false}`);
  if (report.phases) {
    for (const p of FLOW_PHASES) {
      const row = report.phases[p] || {};
      lines.push(`phase.${p}: success=${row.success} reason=${row.reason || ''}`);
    }
  }
  return lines;
}

function createFlowReport(options = {}) {
  const startedAt = Date.now();
  return {
    success: false,
    reason: '',
    phase: 'history',
    phases: {
      history: { success: false, reason: '' },
      listen: { success: false, reason: '' },
      send: { success: false, reason: '' },
    },
    guidedMode: true,
    text: maskTextForReport(options.text || ''),
    confirmSend: Boolean(options.confirmSend),
    skipSend: Boolean(options.skipSend),
    skipListen: Boolean(options.skipListen),
    listenMinutes: Number(options.listenMinutes || LISTEN_DEFAULT_MINUTES),
    timeoutMinutes: Number(options.timeoutMinutes || GUIDED_DEFAULT_TIMEOUT_MINUTES),
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: '',
    durationMs: 0,
    imBridgeSeen: 0,
    activeShopResolved: false,
    shopId: '',
    shopName: '',
    buyerId: '',
    buyerName: '',
    conversationId: '',
    selectedConversationDetected: false,
    historyCaptured: false,
    historyMessageCount: 0,
    buyerHistoryCount: 0,
    sellerHistoryCount: 0,
    historyMessages: [],
    liveMessageCount: 0,
    liveInboundCount: 0,
    liveOutboundCount: 0,
    liveMessages: [],
    conversations: [],
    conversationListCount: 0,
    observerReady: false,
    editorFound: false,
    sendButtonFound: false,
    sent: false,
    verifiedInChat: false,
    outboundMessageId: 0,
    warnings: [],
    errors: [],
    nextActions: [],
    patchManifest: options.patchManifest || null,
    portGuard: options.portGuard || null,
    runLock: options.runLock || null,
  };
}

function countDirections(messages = []) {
  let buyer = 0;
  let seller = 0;
  for (const m of messages) {
    const d = String(m.direction || '').toLowerCase();
    if (d === 'buyer' || d === 'inbound') buyer += 1;
    else if (d === 'seller' || d === 'outbound') seller += 1;
  }
  return { buyer, seller };
}

function runMockMessageFlowSession(options = {}) {
  const report = createFlowReport(options);
  const scenario = options.mockScenario || 'full_success';
  const shop = { shopId: '263636465', shopName: 'XY祥钰珠宝' };
  report.imBridgeSeen = 1;
  report.activeShopResolved = true;
  report.shopId = shop.shopId;
  report.shopName = shop.shopName;
  report.buyerName = '一只小青蛙';
  report.buyerId = 'buyer_q***';
  report.selectedConversationDetected = true;

  if (scenario === 'timeout_no_selection') {
    report.reason = 'timeout_no_selected_conversation';
    report.phase = 'history';
    report.phases.history.reason = 'timeout_no_selected_conversation';
    report.finishedAt = new Date().toISOString();
    report.durationMs = 1000;
    return sanitizeLiveReport(report);
  }

  report.historyMessages = [
    { direction: 'buyer', text: '在吗' },
    { direction: 'seller', text: '您好，有什么可以帮您？' },
    { direction: 'buyer', text: '好' },
  ];
  report.historyMessageCount = report.historyMessages.length;
  const counts = countDirections(report.historyMessages);
  report.buyerHistoryCount = counts.buyer;
  report.sellerHistoryCount = counts.seller;
  report.phases.history = { success: true, reason: 'chat_history_captured' };

  report.liveMessages = [{ direction: 'buyer', text: '新消息测试', buyerName: '一只小青蛙' }];
  report.liveMessageCount = 1;
  report.liveInboundCount = 1;
  report.phases.listen = { success: true, reason: 'listen_window_completed' };

  report.conversations = [
    { buyerName: '钢铁侠', buyerId: '', lastMessage: '[一起加油]', timeText: '18:41' },
    { buyerName: '一只小青蛙', buyerId: 'buyer_q***', lastMessage: '好', timeText: '18:40' },
  ];
  report.conversationListCount = 2;

  if (options.skipSend || !options.confirmSend) {
    report.phase = 'send';
    report.phases.send = {
      success: true,
      reason: options.skipSend ? 'skip_send_requested' : 'missing_confirm_send',
    };
    report.success = true;
    report.reason = 'message_flow_completed_without_send';
    report.finishedAt = new Date().toISOString();
    report.durationMs = 2000;
    return sanitizeLiveReport(report);
  }

  report.sent = true;
  report.verifiedInChat = true;
  report.phase = 'send';
  report.phases.send = { success: true, reason: 'message_sent_and_verified' };
  report.success = true;
  report.reason = 'message_flow_completed';
  report.finishedAt = new Date().toISOString();
  report.durationMs = 3000;
  return sanitizeLiveReport(report);
}

async function runMessageFlowGuidedSession(options = {}) {
  if (options.mockMode) {
    return runMockMessageFlowSession(options);
  }

  const cfg = getDoudianConfig();
  const knownShops = cfg.knownShops || [];
  const bridgePort = Number(options.bridgePort || cfg.bridgePort || 19527);
  const installDir = options.installDir;
  const {
    text = '',
    confirmSend = false,
    skipSend = false,
    skipListen = false,
    timeoutMinutes = GUIDED_DEFAULT_TIMEOUT_MINUTES,
    listenMinutes = LISTEN_DEFAULT_MINUTES,
  } = options;

  const startedAt = Date.now();
  const report = createFlowReport({
    text,
    confirmSend,
    skipSend,
    skipListen,
    timeoutMinutes,
    listenMinutes,
    patchManifest: options.patchManifest,
    portGuard: options.portGuard,
    runLock: options.runLock,
  });

  const dbPath =
    options.dbPath || path.join(process.cwd(), 'logs', 'doudian-message-flow-guided.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  closeDb();
  process.env.DOUDIAN_VERIFY_DB = dbPath;

  const ctx = createImLiveContext({ knownShops, report });
  const dedupe = new DoudianDedupe();
  const pipeline = new DoudianBusinessPipeline({ dedupe });

  let phase = 'history';
  let historyCaptured = false;
  let listenStartedAt = 0;
  let observerStarted = false;
  let selectionAnnounced = false;
  let sendAttempted = false;
  let sendCompleted = false;
  let lastHistoryPollAt = 0;
  let lastListenBriefingAt = 0;
  let lastSendPollAt = 0;
  let lastBriefingAt = 0;
  let outboundMessageId = 0;
  let lastGateReason = '';
  let listPrintedOnce = false;

  function markPhaseSuccess(name, reason) {
    report.phases[name] = { success: true, reason };
  }

  function markPhaseFailed(name, reason) {
    report.phases[name] = { success: false, reason };
  }

  function advancePhase(next, reason) {
    markPhaseSuccess(phase, reason);
    phase = next;
    report.phase = phase;
    console.log(`\n[抖店桥] >>> 进入阶段: ${phase}`);
    if (phase === 'listen') {
      listenStartedAt = Date.now();
      console.log(`[抖店桥] 将监听 WebSocket 实时消息 ${listenMinutes} 分钟（收/发内容会打印到终端）`);
    }
    if (phase === 'send') {
      console.log('[抖店桥] 发送阶段: 将读取买家列表；如需发给其他人请手动点击该买家会话');
      if (skipSend) {
        markPhaseSuccess('send', 'skip_send_requested');
        report.success = true;
        report.reason = 'message_flow_completed_without_send';
        return true;
      }
      if (!confirmSend) {
        markPhaseSuccess('send', 'missing_confirm_send');
        report.success = true;
        report.reason = 'message_flow_completed_without_send';
        report.warnings.push('未传 --confirm-send，发送阶段仅展示列表，不会点击发送');
        return true;
      }
      if (!String(text || '').trim()) {
        markPhaseFailed('send', 'empty_text');
        report.reason = 'empty_text';
        return true;
      }
      const outbound = insertOutboundMessage({
        shopId: report.shopId,
        shopName: report.shopName,
        conversationId: report.conversationId,
        buyerId: report.buyerId,
        buyerName: report.buyerName,
        text,
        status: 'pending',
        sendMethod: 'ui',
      });
      outboundMessageId = outbound.id;
      report.outboundMessageId = outbound.id;
    }
    return false;
  }

  function recordLiveMessage(msg = {}) {
    const row = maskMessageForReport({
      direction: msg.direction || 'unknown',
      text: msg.text || '',
      buyerName: msg.buyerName || report.buyerName || '',
      source: msg.source || 'ws',
    });
    report.liveMessages.push(row);
    if (report.liveMessages.length > 50) report.liveMessages.shift();
    report.liveMessageCount += 1;
    const d = String(row.direction || '').toLowerCase();
    if (d === 'buyer' || d === 'inbound') report.liveInboundCount += 1;
    else if (d === 'seller' || d === 'outbound') report.liveOutboundCount += 1;
    printLiveMessage(row);
  }

  function applyHistoryFromDom(payload = {}) {
    const analysis = analyzeDomInspection(payload);
    const items = bubblesToHistoryItems(analysis.trustedBubbles || []);
    if (!items.length) return;
    report.historyMessages = items.map((m) =>
      maskMessageForReport({
        direction: m.direction,
        text: m.text,
        messageType: m.messageType,
        source: 'dom',
      })
    );
    report.historyMessageCount = report.historyMessages.length;
    const counts = countDirections(report.historyMessages);
    report.buyerHistoryCount = counts.buyer;
    report.sellerHistoryCount = counts.seller;
  }

  function getNextPhaseAfterHistory(reason) {
    if (skipListen) {
      report.phases.listen = { success: true, reason: 'skip_listen_requested' };
      return 'send';
    }
    return 'listen';
  }

  function tryFinishHistoryPhase() {
    if (historyCaptured || phase !== 'history') return;
    const trust = evaluateHistoryTrust({
      ...report,
      shopReportValid: report.activeShopResolved !== false,
    });
    if (!report.selectedConversationDetected) return;
    const fastSendReady = skipListen && confirmSend && isGuidedConversationReady(report);
    if (!fastSendReady && Number(report.historyMessageCount || 0) < 1 && !trust.historyTrusted) return;
    historyCaptured = true;
    report.historyCaptured = true;
    if (report.historyMessages.length) printHistoryMessages(report.historyMessages);
    const historyReason = fastSendReady
      ? 'selection_ready_fast_send'
      : trust.historyTrusted
        ? 'chat_history_captured'
        : 'history_messages_printed';
    const done = advancePhase(getNextPhaseAfterHistory(historyReason), historyReason);
    if (done) return;
  }

  ctx.handlers.push((envelope, p) => {
    if (phase === 'history') {
      if (
        envelope.type === DOUDIAN_EVENTS.CONVERSATION_SOURCES_INSPECTION ||
        envelope.type === DOUDIAN_EVENTS.CONVERSATION_LIST_CAPTURED
      ) {
        applyMergedSourcesToReport(report, p);
        applyEmptyStateFlags(report);
        if (isGuidedConversationReady(report)) {
          report.selectionEverDetected = true;
        }
      }
      if (envelope.type === DOUDIAN_EVENTS.CHAT_DOM_INSPECTION) {
        applyHistoryFromDom(p);
        tryFinishHistoryPhase();
      }
      if (envelope.type === DOUDIAN_EVENTS.CHAT_HISTORY_SNAPSHOT) {
        const rows = Array.isArray(p.messages) ? p.messages : [];
        if (rows.length) {
          report.historyMessages = rows.slice(0, 100).map((m) =>
            maskMessageForReport({
              direction: m.direction || m.directionGuess,
              text: m.text,
              source: 'history_snapshot',
            })
          );
          report.historyMessageCount = report.historyMessages.length;
          const counts = countDirections(report.historyMessages);
          report.buyerHistoryCount = counts.buyer;
          report.sellerHistoryCount = counts.seller;
          tryFinishHistoryPhase();
        }
      }
    }

    if (phase === 'listen' || phase === 'send') {
      if (envelope.type === DOUDIAN_EVENTS.MESSAGE_OBSERVER_READY) {
        report.observerReady = true;
      }
      if (
        envelope.type === DOUDIAN_EVENTS.MESSAGE_INBOUND ||
        envelope.type === DOUDIAN_EVENTS.MESSAGE_REAL_CANDIDATE ||
        envelope.type === DOUDIAN_EVENTS.MESSAGE_DOM_ADDED
      ) {
        recordLiveMessage({
          direction: 'buyer',
          text: pickFirst(p.text, p.messageText, p.content),
          buyerName: pickFirst(p.buyerName, report.buyerName),
          source: envelope.type,
        });
      }
      if (
        envelope.type === DOUDIAN_EVENTS.MESSAGE_OUTBOUND ||
        envelope.type === DOUDIAN_EVENTS.MESSAGE_SEND_RESULT
      ) {
        recordLiveMessage({
          direction: 'seller',
          text: pickFirst(p.text, p.messageText, p.content),
          buyerName: pickFirst(p.buyerName, report.buyerName),
          source: envelope.type,
        });
      }
    }

    if (phase === 'send') {
      if (
        envelope.type === DOUDIAN_EVENTS.CONVERSATION_SOURCES_INSPECTION ||
        envelope.type === DOUDIAN_EVENTS.CONVERSATION_LIST_CAPTURED
      ) {
        applyMergedSourcesToReport(report, p);
        applyEmptyStateFlags(report);
        const allowance = evaluateSendAllowance(report);
        report.conversationListCaptured = allowance.conversationListCaptured;
        report.sendAllowedBySelectedConversation = allowance.sendAllowedBySelectedConversation;
        report.summary = allowance.summary;
        report.conversations = report.conversations || [];
        report.conversationListCount = report.conversations.length;
        if (isGuidedConversationReady(report)) {
          report.selectionEverDetected = true;
        }
      }
      if (envelope.type === DOUDIAN_EVENTS.REPLY_EDITOR_INSPECTION) {
        applyEditorInspectionToReport(report, p, ctx);
      }
      if (envelope.type === DOUDIAN_EVENTS.MESSAGE_SEND_RESULT) {
        applySendResult(report, p);
        sendCompleted = true;
      }
    }

    pipeline.processEnvelope(envelope);
  });

  const boot = await bootstrapImLiveClient({
    installDir,
    bridgePort,
    report,
    ctx,
    logLabel: 'message-flow-guided',
    timeoutMinutes,
  });

  if (!boot.ok) {
    report.reason = boot.reason || 'im_workspace_not_opened';
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeLiveReport(report);
  }

  const { wsServer, child } = boot;
  report.imBridgeSeen = 1;
  if (skipListen && confirmSend) {
    console.log('[抖店桥] 请在 IM 手动点开买家会话，识别后将自动发送消息');
  } else {
    console.log('[抖店桥] 阶段1/历史: 请在 IM 手动点开一个有历史消息的买家会话');
  }
  await sleep(3000);

  const timeoutMs = timeoutMinutes * 60 * 1000;
  const waitStarted = Date.now();

  while (Date.now() - waitStarted < timeoutMs) {
    ctx.applyShopStats();
    applyIntegrityWarningsToReport(report, ctx.integrityWarnings);
    ctx.tracker.refreshShopStats();
    report.imBridgeSeen = Math.max(report.imBridgeSeen || 0, ctx.tracker.hasImBridge() ? 1 : 0);
    report.activeShopResolved = Boolean(report.shopId || report.activeShop?.shopId);

    const imBridgeIds = ctx.tracker.getImBridgeIds();
    ctx.refreshConversationSelectionFromHints();

    if (phase === 'history') {
      if (!selectionAnnounced && isConversationSelected({
        buyerId: report.buyerId,
        buyerName: report.buyerName,
        conversationId: report.conversationId,
      })) {
        selectionAnnounced = true;
        console.log('[抖店桥] 已检测到买家会话，开始读取历史消息...');
        console.log(`buyerName: ${report.buyerName || ''}`);
        console.log(`buyerId: ${report.buyerId ? `${String(report.buyerId).slice(0, 4)}***` : ''}`);
      }

      if (Date.now() - lastHistoryPollAt >= HISTORY_POLL_MS) {
        for (const id of imBridgeIds) {
          wsServer.sendDebugCommand(id, 'debug.get_conversation_hints', {});
          if (skipListen && confirmSend) {
            wsServer.sendDebugCommand(id, 'debug.inspect_conversation_sources', {});
            wsServer.sendDebugCommand(id, 'debug.inspect_reply_editor', {});
          }
          wsServer.sendDebugCommand(id, 'debug.inspect_chat_dom', {});
          wsServer.sendDebugCommand(id, 'debug.read_current_chat_history', {});
        }
        lastHistoryPollAt = Date.now();
      }

      tryFinishHistoryPhase();

      if (Date.now() - lastBriefingAt >= GUIDED_BRIEFING_MS) {
        printGuidedConversationBriefing(report, 'history');
        console.log(`historyMessageCount: ${report.historyMessageCount || 0}`);
        lastBriefingAt = Date.now();
      }

      if (!historyCaptured && !report.selectedConversationDetected && Date.now() - waitStarted >= timeoutMs) {
        break;
      }
    }

    if (phase === 'listen') {
      if (!observerStarted) {
        for (const id of imBridgeIds) {
          wsServer.sendDebugCommand(id, 'debug.start_message_observer', {});
        }
        observerStarted = true;
      }

      const listenElapsed = Date.now() - listenStartedAt;
      if (listenElapsed >= listenMinutes * 60 * 1000) {
        const done = advancePhase('send', 'listen_window_completed');
        if (done) break;
      }

      if (Date.now() - lastListenBriefingAt >= GUIDED_BRIEFING_MS) {
        console.log(
          `[抖店桥] listen: inbound=${report.liveInboundCount} outbound=${report.liveOutboundCount} observerReady=${report.observerReady}`
        );
        lastListenBriefingAt = Date.now();
      }
    }

    if (phase === 'send') {
      if (report.success && (skipSend || !confirmSend)) break;

      if (Date.now() - lastSendPollAt >= GUIDED_POLL_MS) {
        for (const id of imBridgeIds) {
          wsServer.sendDebugCommand(id, 'debug.inspect_conversation_sources', {});
          wsServer.sendDebugCommand(id, 'debug.inspect_reply_editor', {});
        }
        lastSendPollAt = Date.now();
        if (report.conversations?.length && !listPrintedOnce) {
          printConversationList(report.conversations);
          listPrintedOnce = true;
        }
      }

      if (!sendAttempted && !sendCompleted) {
        const gates = evaluateMessageFlowSendGates(report, { confirmSend, text });
        if (gates.ok) {
          sendAttempted = true;
          const buyerLabel = report.buyerName || report.buyerId || '当前选中买家';
          console.log(`[抖店桥] 门禁通过，向「${buyerLabel}」发送消息...`);
          const targetId = imBridgeIds[0];
          if (targetId) {
            wsServer.sendDebugCommand(targetId, 'debug.send_to_current_conversation', {
              text,
              confirmSend: true,
            });
          }
        } else if (gates.reason !== lastGateReason) {
          lastGateReason = gates.reason;
          console.log(`[抖店桥] 等待发送条件: ${gates.reason}`);
        }
      }

      if (sendCompleted) {
        markPhaseSuccess('send', report.reason || 'message_sent');
        report.success = Boolean(report.verifiedInChat);
        report.reason = report.success
          ? 'message_flow_completed'
          : report.sent
            ? 'sent_but_not_verified'
            : report.reason || 'send_failed';
        if (!report.success && report.sent) {
          report.warnings.push('已触发发送动作，但聊天区未出现对应商家气泡，买家端可能未收到');
        }
        break;
      }

      if (Date.now() - lastBriefingAt >= GUIDED_BRIEFING_MS) {
        if (!report.selectionEverDetected) {
          printGuidedConversationBriefing(report, 'send');
        } else {
          const gates = evaluateMessageFlowSendGates(report, { confirmSend, text });
          console.log(
            `[抖店桥] send: editorFound=${report.editorFound} editorConfidence=${report.editorConfidence || 0} sendButtonFound=${report.sendButtonFound} gate=${gates.reason || 'ready'} sent=${report.sent}`
          );
        }
        lastBriefingAt = Date.now();
      }
    }

    if (report.success && phase === 'send' && (skipSend || !confirmSend || sendCompleted)) {
      break;
    }

    await sleep(1000);
  }

  if (!historyCaptured && phase === 'history') {
    markPhaseFailed('history', 'timeout_no_selected_conversation');
    report.reason = 'timeout_no_selected_conversation';
    report.nextActions = [
      '请在 IM 手动点开买家会话后重试',
      'npm run doudian:message-flow-guided -- --timeout-minutes 60',
    ];
  } else if (phase === 'listen' && !report.phases.listen.success) {
    markPhaseSuccess('listen', 'listen_timeout_with_session_end');
    advancePhase('send', 'listen_timeout_with_session_end');
  }

  if (phase === 'send' && confirmSend && !sendCompleted && !report.phases.send.success) {
    const gates = evaluateMessageFlowSendGates(report, { confirmSend, text });
    markPhaseFailed('send', gates.reason || 'send_timeout');
    report.reason = report.selectionEverDetected ? gates.reason || 'send_timeout' : 'timeout_no_selected_conversation';
    if (outboundMessageId) {
      updateOutboundMessage(outboundMessageId, {
        status: 'failed',
        errorReason: report.reason,
      });
    }
  }

  if (historyCaptured && report.phases.listen.success && (skipSend || !confirmSend)) {
    if (!report.reason) report.reason = 'message_flow_completed_without_send';
    report.success = true;
  } else if (
    historyCaptured &&
    report.phases.listen.success &&
    report.phases.send.success &&
    report.verifiedInChat
  ) {
    if (!report.reason) report.reason = 'message_flow_completed';
    report.success = true;
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  try {
    child.unref();
  } catch {
    // ignore
  }
  return sanitizeLiveReport(report);
}

module.exports = {
  runMessageFlowGuidedSession,
  parseMessageFlowCliArgs,
  buildMessageFlowTextReport,
  printHistoryMessages,
  printConversationList,
  FLOW_PHASES,
  LISTEN_DEFAULT_MINUTES,
};
