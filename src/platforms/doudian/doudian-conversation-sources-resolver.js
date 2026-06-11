const { extractConversations, extractLinkInfo } = require('./doudian-pigeon-parser');
const { isValidTrustedBuyerName } = require('./doudian-history-validation');
const { pickFirst } = require('./doudian-shop-utils');
const { maskIdForReport, maskTextForReport } = require('./doudian-conversation-list-parser');

const SOURCE_PRIORITY = ['memory_cache', 'react_fiber', 'dom_geometry', 'selected_fallback'];

function isPlausibleBuyerId(id = '') {
  const s = String(id || '').trim();
  if (!s || s.length < 10) return false;
  if (/llm|proc|worker|bridge|patch|debug|rust|electron|preload/i.test(s)) return false;
  if (/^[0-9a-f]+$/i.test(s) && s.length < 12) return false;
  return true;
}

function isUiEmptyStateText(name = '') {
  const n = String(name || '').trim();
  if (!n) return false;
  return /您今日暂无接待数据|暂无会话中用户|请选择会话|当前会话|最近联系|在线|三方|个人短语|添加备注|客户资料|店铺消费|商家后台|AI智能客服|暂无接待|全店数据|前往查看|与消费者聊天/.test(
    n
  );
}

function hasTrustedBuyerIdentity(entry = {}) {
  if (isUiEmptyStateText(entry.buyerName)) return false;
  return isValidTrustedBuyerName(entry.buyerName) || isPlausibleBuyerId(entry.buyerId);
}

function normalizeRow(row = {}, source = '', index = 0) {
  const buyerId = pickFirst(row.buyerId, row.buyer_id, row.userId, row.user_id, row.uid);
  const buyerName = pickFirst(row.buyerName, row.nickName, row.nickname, row.name, row.user_name);
  const conversationId = pickFirst(
    row.conversationId,
    row.conversation_id,
    row.conversation_short_id
  );
  const lastMessage = pickFirst(
    row.lastMessage,
    row.last_message,
    row.lastMessageText,
    row.content,
    row.text,
    row.msg,
    row.message
  );
  const timeText = pickFirst(row.timeText, row.time, row.timestamp, row.lastMessageTime);
  return {
    index,
    buyerId: String(buyerId || ''),
    buyerName: String(buyerName || ''),
    conversationId: String(conversationId || ''),
    lastMessage: String(lastMessage || ''),
    timeText: String(timeText || ''),
    selected: Boolean(row.selected || row.active || row.is_current || row.isActive),
    source: row.source || source,
    score: Number(row.score || row.confidence || 0),
  };
}

function parseMemoryCacheInspection(memoryCache = {}, rawPayload) {
  let conversations = [];
  if (Array.isArray(memoryCache.conversations) && memoryCache.conversations.length) {
    conversations = memoryCache.conversations.map((row, i) =>
      normalizeRow(row, 'memory_cache', i)
    );
  } else if (rawPayload) {
    conversations = extractConversations(rawPayload, memoryCache.shopInfo || {}).map((row, i) =>
      normalizeRow(
        {
          buyerId: row.buyerId,
          buyerName: row.buyerName,
          conversationId: row.conversationId,
          lastMessage: row.lastMessageText,
          timeText: row.lastMessageTime,
          source: 'memory_cache',
        },
        'memory_cache',
        i
      )
    );
  }
  conversations = conversations.filter((c) => hasTrustedBuyerIdentity(c));
  const selected =
    conversations.find((c) => c.selected) ||
    normalizeRow(memoryCache.selectedConversation || {}, 'memory_cache', -1);
  return {
    source: 'memory_cache',
    conversationCount: conversations.length,
    conversations: conversations.slice(0, 20),
    selectedConversation: hasTrustedBuyerIdentity(selected) ? selected : {},
  };
}

function parseReactFiberInspection(reactFiber = {}) {
  const conversations = (Array.isArray(reactFiber.conversations) ? reactFiber.conversations : [])
    .map((row, i) => normalizeRow(row, 'react_fiber', i))
    .filter((c) => hasTrustedBuyerIdentity(c));
  const selected = normalizeRow(reactFiber.selectedConversation || {}, 'react_fiber', -1);
  return {
    source: 'react_fiber',
    fiberNodeCount: reactFiber.fiberNodeCount || 0,
    conversationLikeObjectCount: reactFiber.conversationLikeObjectCount || conversations.length,
    conversations: conversations.slice(0, 20),
    selectedConversation: hasTrustedBuyerIdentity(selected) ? selected : {},
  };
}

function parseDomGeometryInspection(domList = {}) {
  const items = (Array.isArray(domList.items) ? domList.items : []).map((row, i) =>
    normalizeRow(row, 'dom_geometry', i)
  );
  const conversations = items.filter((c) => hasTrustedBuyerIdentity(c));
  const selected = conversations.find((c) => c.selected) || {};
  return {
    source: 'dom_geometry',
    listArea: domList.listArea || {},
    itemCount: conversations.length,
    items: conversations.slice(0, 20),
    conversations: conversations.slice(0, 20),
    selectedConversation: selected,
  };
}

function parseSelectedFallbackInspection(selected = {}) {
  const normalized = {
    selectedConversationDetected: Boolean(selected.selectedConversationDetected),
    buyerId: pickFirst(selected.buyerId),
    buyerName: pickFirst(selected.buyerName),
    conversationId: pickFirst(selected.conversationId),
    conversationIdSource: pickFirst(selected.conversationIdSource),
    buyerNameSource: pickFirst(selected.buyerNameSource),
    buyerIdSource: pickFirst(selected.buyerIdSource),
    confidence: Number(selected.confidence || 0),
    sources: Array.isArray(selected.sources) ? selected.sources.slice(0, 10) : [],
  };
  normalized.trusted = hasTrustedBuyerIdentity(normalized);
  return normalized;
}

function mergeConversationSources(inspection = {}) {
  const memory = parseMemoryCacheInspection(inspection.memoryCache || {});
  const fiber = parseReactFiberInspection(inspection.reactFiber || {});
  const dom = parseDomGeometryInspection(inspection.domList || {});
  const selectedFallback = parseSelectedFallbackInspection(inspection.selectedConversation || {});

  const merged = [];
  const seen = new Set();
  const blocks = [
    { source: 'memory_cache', rows: memory.conversations },
    { source: 'react_fiber', rows: fiber.conversations },
    { source: 'dom_geometry', rows: dom.conversations },
  ];

  for (const block of blocks) {
    for (const row of block.rows) {
      if (!hasTrustedBuyerIdentity(row)) continue;
      const key = `${row.conversationId}:${row.buyerId}:${row.buyerName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...row, index: merged.length });
    }
  }

  let selectedConversation = {};
  const selectedCandidates = [
    { row: memory.selectedConversation, weight: 30 },
    { row: fiber.selectedConversation, weight: 25 },
    { row: dom.selectedConversation, weight: 22 },
    { row: merged.find((c) => c.selected), weight: 20 },
    {
      row: {
        buyerId: selectedFallback.buyerId,
        buyerName: selectedFallback.buyerName,
        conversationId: selectedFallback.conversationId,
        buyerNameSource: selectedFallback.buyerNameSource,
        conversationIdSource: selectedFallback.conversationIdSource,
        selected: true,
        source: 'selected_fallback',
        score: selectedFallback.confidence,
      },
      weight: selectedFallback.confidence || 18,
    },
  ].sort((a, b) => (b.weight || 0) - (a.weight || 0));

  for (const cand of selectedCandidates) {
    if (cand.row && hasTrustedBuyerIdentity(cand.row)) {
      selectedConversation = { ...normalizeRow(cand.row, cand.row.source || 'selected_fallback', -1), selected: true };
      break;
    }
  }

  if (!merged.length && hasTrustedBuyerIdentity(selectedConversation)) {
    merged.push({ ...selectedConversation, index: 0 });
  }

  const summary = buildSourcesSummary({
    memoryCache: memory,
    reactFiber: fiber,
    domList: dom,
    selectedConversation: selectedFallback,
    conversations: merged,
  });

  return {
    conversations: merged,
    selectedConversation,
    count: merged.length,
    memoryCache: memory,
    reactFiber: fiber,
    domList: dom,
    selectedFallback,
    summary,
  };
}

function buildSourcesSummary(ctx = {}) {
  const memoryCount = ctx.memoryCache?.conversationCount || 0;
  const fiberCount =
    ctx.reactFiber?.conversationLikeObjectCount || ctx.reactFiber?.conversations?.length || 0;
  const domCount = ctx.domList?.itemCount || ctx.domList?.conversations?.length || 0;
  const convCount = Math.max(memoryCount, fiberCount, domCount, ctx.conversations?.length || 0);
  const selected = ctx.selectedConversation || ctx.selectedFallback || {};
  const trusted = hasTrustedBuyerIdentity(selected);
  const selectedDetected = trusted;
  const sendAllowed = trusted;

  let primaryListSource = 'none';
  if (memoryCount > 0) primaryListSource = 'memory_cache';
  else if (fiberCount > 0) primaryListSource = 'react_fiber';
  else if (domCount > 0) primaryListSource = 'dom_geometry';

  return {
    conversationListCaptured: convCount > 0,
    memoryCacheCount: memoryCount,
    reactFiberCount: fiberCount,
    domGeometryCount: domCount,
    selectedConversationDetected: selectedDetected,
    selectedConfidence: Number(selected.confidence || 0),
    primaryListSource,
    sendAllowedBySelectedConversation: sendAllowed,
  };
}

function evaluateSendAllowance(report = {}) {
  const summary = report.summary || buildSourcesSummary(report);
  const selected = report.selectedConversation || {};
  const trusted = hasTrustedBuyerIdentity(selected) || hasTrustedBuyerIdentity(report);
  return {
    conversationListCaptured: Boolean(summary.conversationListCaptured || (report.count || 0) > 0),
    selectedConversationDetected: trusted,
    sendAllowedBySelectedConversation: Boolean(
      summary.sendAllowedBySelectedConversation || trusted
    ),
    summary,
  };
}

function applyMergedSourcesToReport(report, inspection = {}) {
  const merged = mergeConversationSources(inspection);
  report.conversations = merged.conversations;
  report.selectedConversation = {
    ...merged.selectedConversation,
    selected: true,
    buyerNameSource: merged.selectedConversation.buyerNameSource || merged.selectedFallback.buyerNameSource,
    conversationIdSource:
      merged.selectedConversation.conversationIdSource || merged.selectedFallback.conversationIdSource,
  };
  report.count = merged.count;
  report.buyerId = merged.selectedConversation.buyerId || '';
  report.buyerName = merged.selectedConversation.buyerName || '';
  report.conversationId = merged.selectedConversation.conversationId || '';
  const trusted = hasTrustedBuyerIdentity({
    buyerId: merged.selectedConversation.buyerId,
    buyerName: merged.selectedConversation.buyerName,
  });
  report.selectedConversationDetected = trusted;
  report.sourcesInspection = {
    memoryCache: merged.memoryCache,
    reactFiber: merged.reactFiber,
    domList: merged.domList,
    selectedFallback: merged.selectedFallback,
  };
  report.summary = merged.summary;
  report.conversationListCaptured = merged.summary.conversationListCaptured;
  report.sendAllowedBySelectedConversation = merged.summary.sendAllowedBySelectedConversation;
  return merged;
}

function sanitizeSourcesInspectionReport(report) {
  const maskConv = (c) => ({
    ...c,
    buyerId: maskIdForReport(c.buyerId),
    buyerName: maskTextForReport(c.buyerName, 60),
    conversationId: maskIdForReport(c.conversationId),
    lastMessage: maskTextForReport(c.lastMessage, 120),
    timeText: maskTextForReport(c.timeText, 40),
  });
  return {
    ...report,
    selectedConversation: report.selectedConversation ? maskConv(report.selectedConversation) : {},
    conversations: (report.conversations || []).map(maskConv),
    sourcesInspection: report.sourcesInspection
      ? {
          ...report.sourcesInspection,
          memoryCache: report.sourcesInspection.memoryCache
            ? {
                ...report.sourcesInspection.memoryCache,
                conversations: (report.sourcesInspection.memoryCache.conversations || []).map(maskConv),
              }
            : {},
          reactFiber: report.sourcesInspection.reactFiber
            ? {
                ...report.sourcesInspection.reactFiber,
                conversations: (report.sourcesInspection.reactFiber.conversations || []).map(maskConv),
              }
            : {},
          domList: report.sourcesInspection.domList
            ? {
                ...report.sourcesInspection.domList,
                items: (report.sourcesInspection.domList.items || []).map(maskConv),
              }
            : {},
        }
      : undefined,
  };
}

module.exports = {
  SOURCE_PRIORITY,
  isPlausibleBuyerId,
  hasTrustedBuyerIdentity,
  parseMemoryCacheInspection,
  parseReactFiberInspection,
  parseDomGeometryInspection,
  parseSelectedFallbackInspection,
  mergeConversationSources,
  buildSourcesSummary,
  evaluateSendAllowance,
  applyMergedSourcesToReport,
  sanitizeSourcesInspectionReport,
};
