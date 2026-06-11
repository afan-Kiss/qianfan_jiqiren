const { getDoudianConfig } = require('../../shared/config');
const { DOUDIAN_EVENTS } = require('./doudian-types');
const {
  parseConversationListPayload,
  formatConversationListTerminal,
  maskIdForReport,
  maskTextForReport,
} = require('./doudian-conversation-list-parser');
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
  applyMergedSourcesToReport,
  hasTrustedBuyerIdentity,
  isPlausibleBuyerId,
} = require('./doudian-conversation-sources-resolver');

const LIST_CAPTURE_TIMEOUT_MS = 120000;
const LIST_POLL_INTERVAL_MS = 2000;
const LIST_WARMUP_MS = 12000;

function parseListConversationsCliArgs(argv = []) {
  let timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--timeout-minutes' && argv[i + 1]) {
      timeoutMinutes = Math.max(1, Number(argv[++i]) || DEFAULT_TIMEOUT_MINUTES);
    }
  }
  return { timeoutMinutes };
}

function buildConversationListTextReport(report) {
  const lines = [];
  lines.push('=== 抖店当前会话列表报告 ===');
  lines.push(`时间: ${report.finishedAt || new Date().toISOString()}`);
  lines.push(`结果: ${report.success ? '成功' : '失败'}`);
  lines.push(`reason: ${report.reason || ''}`);
  lines.push(`imBridgeSeen: ${report.imBridgeSeen || 0}`);
  lines.push(`activeShop: ${report.activeShop?.shopId || ''} / ${report.activeShop?.shopName || ''}`);
  lines.push(`count: ${report.count || 0}`);
  if (report.selectedConversation) {
    const s = report.selectedConversation;
    lines.push(
      `selected: ${s.buyerName || ''} / ${s.buyerId || ''} / ${s.conversationId || ''}`
    );
  }
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
  lines.push('');
  lines.push(...formatConversationListTerminal(report.conversations || [], report.selectedConversation || {}));
  return lines;
}

function hasListContent(report = {}) {
  const selected = report.selectedConversation || {};
  const namedRows = (report.conversations || []).filter((c) => hasTrustedBuyerIdentity(c));
  return namedRows.length > 0 || hasTrustedBuyerIdentity(selected);
}

function applyActiveShopFallback(report) {
  if (report.activeShop?.shopId) return;
  const logged = (report.loggedInShops || [])[0];
  if (logged?.shopId) {
    report.activeShop = { shopId: logged.shopId, shopName: logged.shopName || '' };
    report.shopId = logged.shopId;
    report.shopName = logged.shopName || '';
    report.activeShopResolved = true;
  }
}

function applyListPayloadToReport(report, payload = {}) {
  if (payload.multiSource || payload.memoryCache || payload.reactFiber || payload.domList) {
    applyMergedSourcesToReport(report, payload);
  } else {
    const parsed = parseConversationListPayload(payload);
    report.conversations = parsed.conversations;
    report.selectedConversation = parsed.selectedConversation;
    report.count = parsed.count;
    report.buyerId = parsed.selectedConversation.buyerId || '';
    report.buyerName = parsed.selectedConversation.buyerName || '';
    report.conversationId = parsed.selectedConversation.conversationId || '';
    report.selectedConversationDetected = hasTrustedBuyerIdentity(parsed.selectedConversation);
  }
  report.success = Boolean(payload.success);
  report.reason = String(payload.reason || report.reason || '');
  if (payload.shopInfo?.shopId || payload.shopInfo?.shopName) {
    report.activeShop = {
      shopId: payload.shopInfo.shopId || report.activeShop?.shopId || '',
      shopName: payload.shopInfo.shopName || report.activeShop?.shopName || '',
    };
  }
}

function buildMockListPayload(scenario = 'success') {
  if (scenario === 'empty') {
    return {
      success: true,
      reason: 'conversation_list_captured',
      shopInfo: { shopId: '263636465', shopName: 'XY祥钰珠宝' },
      selectedConversation: { buyerId: '', buyerName: '', conversationId: '', lastMessage: '', selected: true },
      conversations: [],
      count: 0,
    };
  }
  return {
    success: true,
    reason: 'conversation_list_captured',
    shopInfo: { shopId: '263636465', shopName: 'XY祥钰珠宝' },
    selectedConversation: {
      buyerId: 'buyer_qingwa_001',
      buyerName: '一只小青蛙',
      conversationId: 'conv_qingwa_001',
      lastMessage: '用户超时未回复，系统关闭会话',
      selected: true,
    },
    conversations: [
      {
        index: 0,
        buyerId: 'buyer_qingwa_001',
        buyerName: '一只小青蛙',
        conversationId: 'conv_qingwa_001',
        lastMessage: '用户超时未回复，系统关闭会话',
        timeText: '18:12',
        selected: true,
      },
      {
        index: 1,
        buyerId: 'buyer_other_002',
        buyerName: '测试买家B',
        conversationId: 'conv_other_002',
        lastMessage: '你好',
        timeText: '17:30',
        selected: false,
      },
    ],
    count: 2,
  };
}

async function runConversationListSession(options = {}) {
  const cfg = getDoudianConfig();
  const knownShops = cfg.knownShops || [];
  const bridgePort = Number(options.bridgePort || cfg.bridgePort || 19527);
  const installDir = options.installDir;
  const mockMode = Boolean(options.mockMode);
  const mockScenario = options.mockScenario || 'success';
  const timeoutMinutes = Number(options.timeoutMinutes || DEFAULT_TIMEOUT_MINUTES);
  const startedAt = Date.now();

  const report = {
    success: false,
    reason: '',
    imBridgeSeen: 0,
    activeShop: { shopId: '', shopName: '' },
    activeShopResolved: false,
    selectedConversation: {
      buyerId: '',
      buyerName: '',
      conversationId: '',
      lastMessage: '',
      selected: false,
    },
    selectedConversationDetected: false,
    conversationListCaptured: false,
    sendAllowedBySelectedConversation: false,
    summary: {},
    conversations: [],
    count: 0,
    buyerId: '',
    buyerName: '',
    conversationId: '',
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
    report.imBridgeSeen = 1;
    report.activeShopResolved = true;
    report.activeShop = { shopId: '263636465', shopName: 'XY祥钰珠宝' };
    applyListPayloadToReport(report, buildMockListPayload(mockScenario));
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeConversationListReport(report);
  }

  const ctx = createImLiveContext({ knownShops, report });
  let listCaptured = false;

  ctx.handlers.push((envelope) => {
    if (envelope.type === DOUDIAN_EVENTS.CONVERSATION_SOURCES_INSPECTION) {
      applyListPayloadToReport(report, envelope.payload || {});
      applyActiveShopFallback(report);
      listCaptured = Boolean(report.success && hasListContent(report));
    }
    if (envelope.type === DOUDIAN_EVENTS.CONVERSATION_LIST_CAPTURED) {
      applyListPayloadToReport(report, envelope.payload || {});
      applyActiveShopFallback(report);
      listCaptured = Boolean(
        report.success &&
          (report.reason === 'conversation_list_captured' ||
            report.reason === 'conversation_sources_inspected') &&
          hasListContent(report)
      );
    }
  });

  const boot = await bootstrapImLiveClient({
    installDir,
    bridgePort,
    report,
    ctx,
    logLabel: 'list-current-conversations',
    timeoutMinutes,
  });

  if (!boot.ok) {
    report.reason = boot.reason || 'im_workspace_not_opened';
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeConversationListReport(report);
  }

  const { wsServer, child } = boot;
  report.imBridgeSeen = 1;
  console.log(`[抖店桥] 等待 IM 会话列表渲染（${LIST_WARMUP_MS / 1000}s）...`);
  await sleep(LIST_WARMUP_MS);
  const deadline = Date.now() + Math.min(LIST_CAPTURE_TIMEOUT_MS, timeoutMinutes * 60 * 1000);
  let lastListRequestAt = 0;

  while (!listCaptured && Date.now() < deadline) {
    ctx.applyShopStats();
    applyIntegrityWarningsToReport(report, ctx.integrityWarnings);
    ctx.tracker.refreshShopStats();
    report.imBridgeSeen = Math.max(report.imBridgeSeen || 0, ctx.tracker.hasImBridge() ? 1 : 0);

    const imBridgeIds = ctx.tracker.getImBridgeIds();
    if (Date.now() - lastListRequestAt >= HINTS_INTERVAL_MS) {
      for (const id of imBridgeIds) {
        wsServer.sendDebugCommand(id, 'debug.inspect_conversation_sources', {});
        wsServer.sendDebugCommand(id, 'debug.list_current_conversations', {});
      }
      lastListRequestAt = Date.now();
    }

    await sleep(LIST_POLL_INTERVAL_MS);
  }

  applyActiveShopFallback(report);
  if (!listCaptured) {
    if (hasListContent(report)) {
      report.success = true;
      report.reason = report.reason || 'conversation_list_captured';
      listCaptured = true;
    } else if (report.sendAllowedBySelectedConversation || report.selectedConversationDetected) {
      report.success = true;
      report.reason = 'selected_conversation_only';
      report.warnings.push('完整会话列表未读取，但当前选中会话已识别');
      listCaptured = true;
    } else {
      report.reason = report.reason || 'conversation_list_timeout';
      report.success = false;
    }
  }

  const terminalLines = formatConversationListTerminal(
    report.conversations || [],
    report.selectedConversation || {}
  );
  for (const line of terminalLines) console.log(line);

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  try {
    child.unref();
  } catch {
    // ignore
  }
  return sanitizeConversationListReport(report);
}

function sanitizeConversationListReport(report) {
  const sanitized = sanitizeLiveReport(report);
  return {
    ...sanitized,
    selectedConversation: report.selectedConversation
      ? {
          ...report.selectedConversation,
          buyerId: maskIdForReport(report.selectedConversation.buyerId),
          buyerName: maskTextForReport(report.selectedConversation.buyerName, 60),
          conversationId: maskIdForReport(report.selectedConversation.conversationId),
          lastMessage: maskTextForReport(report.selectedConversation.lastMessage, 120),
        }
      : report.selectedConversation,
    conversations: (report.conversations || []).map((c) => ({
      ...c,
      buyerId: maskIdForReport(c.buyerId),
      buyerName: maskTextForReport(c.buyerName, 60),
      conversationId: maskIdForReport(c.conversationId),
      lastMessage: maskTextForReport(c.lastMessage, 120),
      timeText: maskTextForReport(c.timeText, 40),
    })),
  };
}

module.exports = {
  runConversationListSession,
  parseListConversationsCliArgs,
  buildConversationListTextReport,
  applyListPayloadToReport,
  buildMockListPayload,
};
