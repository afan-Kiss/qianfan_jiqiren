const { pickFirst } = require('./doudian-shop-utils');
const {
  isValidTrustedBuyerName,
  isBlockedBuyerName,
  evaluateConversationSelection,
} = require('./doudian-history-validation');
const { extractLinkInfo, resolveApiName } = require('./doudian-pigeon-parser');

function buildFallbackConversationId(shopId, buyerId) {
  const sid = String(shopId || '').trim();
  const bid = String(buyerId || '').trim();
  if (!sid || !bid) return '';
  return `doudian:${sid}:buyer:${bid}`;
}

function pickTrustedBuyerName(name, source) {
  if (!isValidTrustedBuyerName(name)) return null;
  return { buyerName: String(name).trim(), buyerNameSource: source, buyerNameTrusted: true };
}

function normalizeDomHints(raw = {}) {
  const hints = raw.hints || raw.selectedConversation || raw;
  return {
    conversationId: pickFirst(hints.conversationId),
    conversationIdSource: pickFirst(hints.conversationIdSource),
    buyerId: pickFirst(hints.buyerId, hints.profileBuyerId),
    buyerIdSource: pickFirst(hints.buyerIdSource),
    buyerName: pickFirst(hints.buyerName, hints.chatHeaderBuyerName, hints.sessionListBuyerName),
    buyerNameSource: pickFirst(hints.buyerNameSource),
    chatHeaderBuyerName: pickFirst(hints.chatHeaderBuyerName, hints.buyerName),
    sessionListBuyerName: pickFirst(hints.sessionListBuyerName),
    profileBuyerId: pickFirst(hints.profileBuyerId),
  };
}

function resolveSelectedConversation(report = {}, sources = {}, shopInfo = {}) {
  const domHints = normalizeDomHints(sources.domHints || sources);
  const memoryHints = sources.memoryHints || {};
  const shopId = pickFirst(shopInfo.shopId, report.activeImShops?.[0]?.shopId, sources.shopId);

  let conversationId = '';
  let conversationIdSource = '';
  let buyerId = '';
  let buyerIdSource = '';
  let buyerName = '';
  let buyerNameSource = '';
  let buyerNameTrusted = false;
  let fallbackConversationIdUsed = false;

  const nameCandidates = [
    { name: domHints.chatHeaderBuyerName, source: 'chat_header' },
    { name: domHints.buyerName, source: domHints.buyerNameSource || 'selected_conversation' },
    { name: domHints.sessionListBuyerName, source: 'session_list_item' },
    { name: memoryHints.buyerName, source: memoryHints.buyerNameSource || 'memory_cache' },
    { name: report.buyerName, source: report.buyerNameSource || 'report' },
  ];
  for (const c of nameCandidates) {
    const picked = pickTrustedBuyerName(c.name, c.source);
    if (picked) {
      buyerName = picked.buyerName;
      buyerNameSource = picked.buyerNameSource;
      buyerNameTrusted = picked.buyerNameTrusted;
      break;
    }
  }

  const buyerIdCandidates = [
    { id: domHints.buyerId, source: domHints.buyerIdSource || 'chat_area' },
    { id: domHints.profileBuyerId, source: 'customer_profile' },
    { id: memoryHints.buyerId, source: memoryHints.buyerIdSource || 'memory_cache' },
    { id: report.buyerId, source: report.buyerIdSource || 'report' },
  ];
  for (const c of buyerIdCandidates) {
    const id = pickFirst(c.id);
    if (id) {
      buyerId = id;
      buyerIdSource = c.source;
      break;
    }
  }

  const convIdCandidates = [
    { id: domHints.conversationId, source: domHints.conversationIdSource || 'selected_conversation' },
    { id: memoryHints.conversationId, source: memoryHints.conversationIdSource || 'memory_cache' },
    { id: report.conversationId, source: report.conversationIdSource || 'report' },
  ];
  for (const c of convIdCandidates) {
    const id = pickFirst(c.id);
    if (id && !/^doudian:/.test(id)) {
      conversationId = id;
      conversationIdSource = c.source;
      break;
    }
  }

  if (!conversationId && buyerId && shopId) {
    conversationId = buildFallbackConversationId(shopId, buyerId);
    conversationIdSource = 'fallback_buyerId';
    fallbackConversationIdUsed = true;
  }

  const selection = evaluateConversationSelection({
    conversationId,
    buyerId,
    buyerName: buyerNameTrusted ? buyerName : '',
  });

  return {
    conversationId,
    conversationIdSource,
    buyerId,
    buyerIdSource,
    buyerName,
    buyerNameSource,
    buyerNameTrusted,
    fallbackConversationIdUsed,
    selectedConversationDetected: selection.selectedConversationDetected,
    conversationTrusted: selection.conversationTrusted,
    uiNoiseBuyerNameDetected: selection.uiNoiseBuyerNameDetected,
  };
}

function resolveConversationContext(report = {}, hints = {}, shopInfo = {}) {
  return resolveSelectedConversation(report, { domHints: hints }, shopInfo);
}

function isConversationSelected(resolved = {}) {
  return Boolean(
    resolved.selectedConversationDetected ||
      resolved.conversationId ||
      resolved.buyerId ||
      resolved.buyerNameTrusted
  );
}

function mergeConversationFromMemoryCache(report = {}, payload = {}, apiName = '') {
  const updates = {};
  const name = resolveApiName(apiName);

  if (/get_link_info/i.test(name)) {
    const link = extractLinkInfo(payload);
    if (link.conversationId) {
      updates.conversationId = link.conversationId;
      updates.conversationIdSource = 'memory_cache_get_link_info';
    }
    if (link.buyerId) {
      updates.buyerId = link.buyerId;
      updates.buyerIdSource = 'memory_cache_get_link_info';
    }
    const picked = pickTrustedBuyerName(link.buyerName, 'memory_cache_get_link_info');
    if (picked) Object.assign(updates, picked);
  }

  if (/get_current_conversation_list|conversation_list/i.test(name)) {
    const data = payload?.data || payload;
    const list = Array.isArray(data?.list) ? data.list : Array.isArray(data) ? data : [];
    const active =
      list.find((row) => row.active || row.selected || row.is_current || row.isActive) || list[0];
    if (active) {
      const convId = pickFirst(
        active.conversation_id,
        active.conversationId,
        active.conversation_short_id
      );
      if (convId) {
        updates.conversationId = convId;
        updates.conversationIdSource = 'memory_cache_conversation_list';
      }
      const bid = pickFirst(active.user_id, active.buyerId, active.uid);
      if (bid) {
        updates.buyerId = bid;
        updates.buyerIdSource = 'memory_cache_conversation_list';
      }
      const picked = pickTrustedBuyerName(
        pickFirst(active.nickname, active.buyerName, active.user_name),
        'memory_cache_conversation_list'
      );
      if (picked) Object.assign(updates, picked);
    }
  }

  return updates;
}

function applyConversationUpdates(report, updates = {}) {
  if (updates.conversationId && !/^doudian:/.test(String(report.conversationId || ''))) {
    report.conversationId = updates.conversationId;
    report.conversationIdSource = updates.conversationIdSource || report.conversationIdSource;
    report.fallbackConversationIdUsed = false;
  } else if (updates.conversationId && !report.conversationId) {
    report.conversationId = updates.conversationId;
    report.conversationIdSource = updates.conversationIdSource || '';
    report.fallbackConversationIdUsed = updates.conversationIdSource === 'fallback_buyerId';
  }
  if (updates.buyerId) {
    report.buyerId = updates.buyerId;
    if (updates.buyerIdSource) report.buyerIdSource = updates.buyerIdSource;
  }
  if (updates.buyerName && updates.buyerNameTrusted) {
    report.buyerName = updates.buyerName;
    report.buyerNameSource = updates.buyerNameSource || '';
    report.buyerNameTrusted = true;
  }
  if (isBlockedBuyerName(report.buyerName)) {
    report.buyerName = '';
    report.buyerNameTrusted = false;
  }
}

function applySelectedConversationToReport(report, resolved = {}, shopInfo = {}) {
  if (resolved.conversationId) {
    report.conversationId = resolved.conversationId;
    report.conversationIdSource = resolved.conversationIdSource || report.conversationIdSource;
    report.fallbackConversationIdUsed = Boolean(resolved.fallbackConversationIdUsed);
  }
  if (resolved.buyerId) {
    report.buyerId = resolved.buyerId;
    report.buyerIdSource = resolved.buyerIdSource || report.buyerIdSource;
  }
  if (resolved.buyerNameTrusted) {
    report.buyerName = resolved.buyerName;
    report.buyerNameSource = resolved.buyerNameSource || report.buyerNameSource;
    report.buyerNameTrusted = true;
  }
  report.selectedConversationDetected = Boolean(resolved.selectedConversationDetected);
  report.conversationTrusted = Boolean(resolved.conversationTrusted);
  if (resolved.uiNoiseBuyerNameDetected) {
    report.uiNoiseBuyerNameDetected = true;
  }
  const shop = shopInfo.shopId
    ? shopInfo
    : { shopId: report.activeImShops?.[0]?.shopId, shopName: report.activeImShops?.[0]?.shopName };
  report.activeShop = {
    shopId: pickFirst(shop.shopId),
    shopName: pickFirst(shop.shopName),
  };
  return resolved;
}

module.exports = {
  buildFallbackConversationId,
  normalizeDomHints,
  resolveConversationContext,
  resolveSelectedConversation,
  isConversationSelected,
  mergeConversationFromMemoryCache,
  applyConversationUpdates,
  applySelectedConversationToReport,
  pickTrustedBuyerName,
};
