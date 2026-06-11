const { getDoudianConfig } = require('../../shared/config');
const { DOUDIAN_EVENTS } = require('./doudian-types');
const {
  insertOutboundMessage,
  updateOutboundMessage,
} = require('./doudian-data-store');
const {
  analyzeReplyEditorInspection,
  EDITOR_CONFIDENCE_THRESHOLD,
} = require('./doudian-reply-editor-detector');
const { pickFirst } = require('./doudian-shop-utils');
const { maskIdForReport, maskTextForReport } = require('./doudian-conversation-list-parser');
const {
  applyMergedSourcesToReport,
  evaluateSendAllowance,
  hasTrustedBuyerIdentity,
} = require('./doudian-conversation-sources-resolver');
const {
  createImLiveContext,
  bootstrapImLiveClient,
  sanitizeLiveReport,
  sleep,
  DEFAULT_TIMEOUT_MINUTES,
  HINTS_INTERVAL_MS,
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

const BRIEFING_MS = 5000;
const VERIFY_CHAT_TIMEOUT_MS = 15000;
const SEND_WARMUP_MS = 12000;

function parseSendCurrentConversationCliArgs(argv = []) {
  let text = '';
  let confirmSend = false;
  let timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--text' && argv[i + 1]) text = String(argv[++i]);
    else if (argv[i] === '--confirm-send') confirmSend = true;
    else if (argv[i] === '--timeout-minutes' && argv[i + 1]) {
      timeoutMinutes = Math.max(1, Number(argv[++i]) || DEFAULT_TIMEOUT_MINUTES);
    }
  }
  return { text, confirmSend, timeoutMinutes };
}

function hasBuyerIdentity(report = {}) {
  return hasTrustedBuyerIdentity(report);
}

function evaluateSendCurrentGates(report, options = {}) {
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
  if (!report.selectedConversationDetected) {
    return { ok: false, reason: 'no_selected_conversation' };
  }
  if (!hasBuyerIdentity(report)) {
    return { ok: false, reason: 'no_selected_conversation' };
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

function buildSendCurrentTextReport(report) {
  const lines = [];
  lines.push('=== 抖店发送给当前选中会话报告 ===');
  lines.push(`时间: ${report.finishedAt || new Date().toISOString()}`);
  lines.push(`结果: ${report.success ? '成功' : '失败'}`);
  lines.push(`reason: ${report.reason || ''}`);
  lines.push(`shopId: ${report.shopId || ''}`);
  lines.push(`shopName: ${report.shopName || ''}`);
  lines.push(`buyerId: ${report.buyerId || ''}`);
  lines.push(`buyerName: ${report.buyerName || ''}`);
  lines.push(`conversationId: ${report.conversationId || ''}`);
  lines.push(`selectedConversationDetected: ${report.selectedConversationDetected}`);
  lines.push(`conversationListCaptured: ${report.conversationListCaptured}`);
  lines.push(`sendAllowedBySelectedConversation: ${report.sendAllowedBySelectedConversation}`);
  lines.push(`text: ${report.text || ''}`);
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

function buildSendCurrentGuidedTextReport(report) {
  const lines = buildSendCurrentTextReport(report);
  lines.splice(4, 0, `guidedMode: ${report.guidedMode || false}`);
  if (report.waitedForUserSelectionMs != null) {
    lines.push(`waitedForUserSelectionMs: ${report.waitedForUserSelectionMs}`);
  }
  if (report.emptyStateDetected) {
    lines.push(`emptyStateDetected: ${report.emptyStateDetected}`);
    lines.push(`emptyStateText: ${report.emptyStateText || ''}`);
  }
  return lines;
}

function printSendCurrentBriefing(report) {
  console.log('[抖店桥] send-to-current-conversation:');
  console.log(`activeShop: ${report.shopId || ''} / ${report.shopName || ''}`);
  console.log(`buyerName: ${report.buyerName || ''}`);
  console.log(`selectedConversationDetected: ${report.selectedConversationDetected}`);
  console.log(`editorFound: ${report.editorFound}`);
  console.log(`sendButtonFound: ${report.sendButtonFound}`);
  if (!report.confirmSend) {
    console.log('状态: 缺少 --confirm-send，不会发送');
    return;
  }
  if (!report.selectedConversationDetected || !hasBuyerIdentity(report)) {
    console.log('状态: 未检测到当前选中会话，请在 IM 左侧选中买家');
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
    conversationId: overrides.conversationId || 'doudian:263636465:buyer:buyer_qingwa_001',
    selectedConversation: {
      buyerName: overrides.buyerName || '一只小青蛙',
      buyerId: overrides.buyerId || 'buyer_qingwa_001',
      conversationId: overrides.conversationId || 'doudian:263636465:buyer:buyer_qingwa_001',
    },
  };
}

function applyEditorInspection(report, payload = {}, ctx) {
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

async function runSendCurrentConversationSession(options = {}) {
  const cfg = getDoudianConfig();
  const knownShops = cfg.knownShops || [];
  const bridgePort = Number(options.bridgePort || cfg.bridgePort || 19527);
  const installDir = options.installDir;
  const mockMode = Boolean(options.mockMode);
  const mockScenario = options.mockScenario || '';
  const guidedMode = Boolean(options.guidedMode);
  const timeoutMinutes = Number(
    options.timeoutMinutes || (guidedMode ? GUIDED_DEFAULT_TIMEOUT_MINUTES : DEFAULT_TIMEOUT_MINUTES)
  );
  const text = String(options.text || '');
  const confirmSend = Boolean(options.confirmSend);
  const startedAt = Date.now();

  const report = {
    success: false,
    reason: '',
    shopId: '',
    shopName: '',
    conversationId: '',
    buyerId: '',
    buyerName: '',
    text: maskTextForReport(text),
    confirmSend,
    imBridgeSeen: 0,
    imOpenAttempts: [],
    imOpenSuccess: false,
    activeShopResolved: false,
    activeShop: { shopId: '', shopName: '' },
    selectedConversationDetected: false,
    conversationListCaptured: false,
    sendAllowedBySelectedConversation: false,
    summary: {},
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
    guidedMode,
    waitedForUserSelectionMs: 0,
    emptyStateDetected: false,
    emptyStateText: '',
    selectionEverDetected: false,
  };

  if (!confirmSend) {
    report.reason = 'missing_confirm_send';
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    const blocked = insertOutboundMessage({
      text,
      status: 'blocked',
      sendMethod: 'ui',
      verifiedInChat: false,
      errorReason: report.reason,
    });
    report.outboundMessageId = blocked.id;
    return sanitizeSendCurrentReport(report);
  }

  if (mockMode) {
    return runMockSendCurrentSession(report, { mockScenario, text, confirmSend, startedAt, guidedMode });
  }

  const ctx = createImLiveContext({ knownShops, report });
  let sendAttempted = false;
  let sendCompleted = false;
  let lastHintsAt = 0;
  let lastInspectAt = 0;
  let lastBriefingAt = 0;
  let waitStarted = 0;
  const selectionWaitStarted = Date.now();

  ctx.handlers.push((envelope, p) => {
    if (envelope.type === DOUDIAN_EVENTS.REPLY_EDITOR_INSPECTION) {
      applyEditorInspection(report, p, ctx);
    }
    if (envelope.type === DOUDIAN_EVENTS.MESSAGE_SEND_RESULT) {
      applySendResult(report, p);
      sendCompleted = true;
    }
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
      const selected = report.selectedConversation || {};
      if (hasTrustedBuyerIdentity(selected)) {
        ctx.latestDomHints = {
          ...ctx.latestDomHints,
          buyerName: pickFirst(selected.buyerName, ctx.latestDomHints.buyerName),
          buyerId: pickFirst(selected.buyerId, ctx.latestDomHints.buyerId),
          conversationId: pickFirst(selected.conversationId, ctx.latestDomHints.conversationId),
          sessionListBuyerName: selected.buyerName || '',
        };
        ctx.refreshConversationSelectionFromHints();
      }
      if (isGuidedConversationReady(report)) {
        report.selectionEverDetected = true;
      }
      if (!report.conversationListCaptured && report.sendAllowedBySelectedConversation) {
        const warn = '完整会话列表未读取，但当前选中会话可信，允许发送';
        if (!report.warnings.includes(warn)) report.warnings.push(warn);
      }
    }
  });

  function trySend(wsServer, imBridgeIds) {
    if (sendAttempted || sendCompleted) return;
    const gates = evaluateSendCurrentGates(report, { confirmSend, text });
    if (!gates.ok) {
      if (guidedMode) {
        if (
          gates.reason !== 'no_selected_conversation' &&
          gates.reason !== 'im_bridge_not_seen' &&
          gates.reason !== 'active_shop_not_resolved'
        ) {
          report.reason = gates.reason;
        }
        return;
      }
      if (!report.reason) report.reason = gates.reason;
      return;
    }
    sendAttempted = true;
    const buyerLabel = report.buyerName || report.buyerId || '当前选中买家';
    console.log(`[抖店桥] 门禁通过，向当前选中会话「${buyerLabel}」发送消息（UI 点击）`);
    const targetId = imBridgeIds[0];
    if (targetId) {
      wsServer.sendDebugCommand(targetId, 'debug.send_to_current_conversation', {
        text,
        confirmSend: true,
      });
    }
  }

  const boot = await bootstrapImLiveClient({
    installDir,
    bridgePort,
    report,
    ctx,
    logLabel: guidedMode ? 'send-to-current-conversation-guided' : 'send-to-current-conversation',
    timeoutMinutes,
  });

  if (!boot.ok) {
    report.reason = boot.reason || 'im_workspace_not_opened';
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    const blocked = insertOutboundMessage({
      shopId: report.shopId,
      shopName: report.shopName,
      text,
      buyerName: report.buyerName,
      status: 'blocked',
      errorReason: report.reason,
    });
    report.outboundMessageId = blocked.id;
    return sanitizeSendCurrentReport(report);
  }

  const { wsServer, child } = boot;
  report.imBridgeSeen = 1;
  if (guidedMode) {
    console.log('[抖店桥] guided 模式: IM 就绪后将持续等待您手动点开买家会话，选中后再发送');
  }
  console.log(`[抖店桥] 等待 IM 会话与输入区就绪（${SEND_WARMUP_MS / 1000}s）...`);
  await sleep(SEND_WARMUP_MS);
  const logged = (report.loggedInShops || [])[0];
  if (!report.activeShop?.shopId && logged?.shopId) {
    report.activeShop = { shopId: logged.shopId, shopName: logged.shopName || '' };
    report.shopId = logged.shopId;
    report.shopName = logged.shopName || '';
    report.activeShopResolved = true;
  }
  waitStarted = Date.now();
  const timeoutMs = timeoutMinutes * 60 * 1000;

  const outboundRow = insertOutboundMessage({
    shopId: report.shopId,
    shopName: report.shopName,
    conversationId: report.conversationId,
    buyerId: report.buyerId,
    buyerName: report.buyerName,
    text,
    status: 'pending',
    sendMethod: 'ui',
  });
  report.outboundMessageId = outboundRow.id;

  while (!sendCompleted && Date.now() - waitStarted < timeoutMs) {
    ctx.applyShopStats();
    applyIntegrityWarningsToReport(report, ctx.integrityWarnings);
    ctx.tracker.refreshShopStats();
    report.imBridgeSeen = Math.max(report.imBridgeSeen || 0, ctx.tracker.hasImBridge() ? 1 : 0);

    const imBridgeIds = ctx.tracker.getImBridgeIds();
    ctx.refreshConversationSelectionFromHints();

    const pollMs = guidedMode ? GUIDED_POLL_MS : HINTS_INTERVAL_MS;
    if (Date.now() - lastHintsAt >= pollMs) {
      for (const id of imBridgeIds) {
        wsServer.sendDebugCommand(id, 'debug.inspect_conversation_sources', {});
      }
      lastHintsAt = Date.now();
    }

    if (
      Date.now() - lastInspectAt >= pollMs &&
      (!guidedMode || report.selectionEverDetected || isGuidedConversationReady(report))
    ) {
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

    if (Date.now() - lastBriefingAt >= (guidedMode ? GUIDED_BRIEFING_MS : BRIEFING_MS)) {
      if (guidedMode && !report.selectionEverDetected) {
        printGuidedConversationBriefing(report, 'send guided');
      } else {
        printSendCurrentBriefing(report);
      }
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

  report.waitedForUserSelectionMs = Date.now() - selectionWaitStarted;

  if (!sendCompleted) {
    const gates = evaluateSendCurrentGates(report, { confirmSend, text });
    if (guidedMode && !report.selectionEverDetected) {
      report.reason = 'timeout_no_selected_conversation';
    } else {
      report.reason = gates.reason || report.reason || 'send_timeout';
    }
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
  return sanitizeSendCurrentReport(report);
}

function runMockSendCurrentSession(report, ctx) {
  const { mockScenario, text, confirmSend, startedAt, guidedMode } = ctx;
  const shopInfo = { shopId: '263636465', shopName: 'XY祥钰珠宝' };
  report.imBridgeSeen = 1;
  report.activeShop = shopInfo;
  report.activeShopResolved = true;
  report.shopId = shopInfo.shopId;
  report.shopName = shopInfo.shopName;

  const outbound = insertOutboundMessage({
    shopId: shopInfo.shopId,
    shopName: shopInfo.shopName,
    text,
    buyerName: '一只小青蛙',
    status: 'pending',
    sendMethod: 'ui',
  });
  report.outboundMessageId = outbound.id;

  if (mockScenario === 'no_selected' || (guidedMode && mockScenario === 'guided_timeout')) {
    report.selectedConversationDetected = false;
    report.reason = guidedMode ? 'timeout_no_selected_conversation' : 'no_selected_conversation';
    report.guidedMode = guidedMode;
    report.emptyStateDetected = guidedMode;
    report.emptyStateText = guidedMode ? '您今日暂无接待数据' : '';
    report.waitedForUserSelectionMs = guidedMode ? 5000 : 0;
    updateOutboundMessage(report.outboundMessageId, { status: 'blocked', errorReason: report.reason });
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeSendCurrentReport(report);
  }

  if (guidedMode && mockScenario === 'guided_empty_wait') {
    report.guidedMode = true;
    report.emptyStateDetected = true;
    report.emptyStateText = '您今日暂无接待数据';
    report.selectedConversationDetected = false;
    report.reason = '';
    report.success = false;
    report.waitedForUserSelectionMs = 3000;
    report.mockGuidedSummary = { keptWaitingOnEmpty: true };
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeSendCurrentReport(report);
  }

  const payload =
    mockScenario === 'editor_missing'
      ? buildMockEditorPayload({ editorCandidates: [], sendButtonCandidates: [] })
      : mockScenario === 'send_button_missing'
        ? buildMockEditorPayload({ sendButtonCandidates: [] })
        : buildMockEditorPayload({ buyerName: '一只小青蛙' });

  const analysis = analyzeReplyEditorInspection(payload);
  report.editorFound = analysis.editorFound;
  report.editorConfidence = analysis.editorConfidence;
  report.sendButtonFound = analysis.sendButtonFound;
  report.sendButtonEnabled = analysis.sendButtonEnabled !== false;
  report.buyerId = payload.buyerId || '';
  report.conversationId = payload.conversationId || '';
  report.buyerName = payload.buyerName || '';
  report.guidedMode = guidedMode;
  report.selectedConversationDetected = mockScenario !== 'no_selected';
  report.selectionEverDetected = report.selectedConversationDetected;
  report.conversationListCaptured = mockScenario !== 'no_selected' && mockScenario !== 'selected_only';
  report.sendAllowedBySelectedConversation = report.selectedConversationDetected;
  report.waitedForUserSelectionMs = guidedMode ? 4000 : 0;
  if (mockScenario === 'selected_only') {
    report.conversationListCaptured = false;
    report.warnings = ['完整会话列表未读取，但当前选中会话可信，允许发送'];
  }

  if (mockScenario === 'editor_missing') {
    report.reason = 'reply_editor_not_found';
    updateOutboundMessage(report.outboundMessageId, { status: 'blocked', errorReason: report.reason });
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeSendCurrentReport(report);
  }
  if (mockScenario === 'send_button_missing') {
    report.reason = 'send_button_not_found';
    updateOutboundMessage(report.outboundMessageId, { status: 'blocked', errorReason: report.reason });
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeSendCurrentReport(report);
  }

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
  return sanitizeSendCurrentReport(report);
}

function sanitizeSendCurrentReport(report) {
  return sanitizeLiveReport(report);
}

async function runSendCurrentConversationGuidedSession(options = {}) {
  return runSendCurrentConversationSession({ ...options, guidedMode: true });
}

module.exports = {
  runSendCurrentConversationSession,
  runSendCurrentConversationGuidedSession,
  parseSendCurrentConversationCliArgs,
  buildSendCurrentTextReport,
  buildSendCurrentGuidedTextReport,
  evaluateSendCurrentGates,
  hasBuyerIdentity,
  printSendCurrentBriefing,
};
