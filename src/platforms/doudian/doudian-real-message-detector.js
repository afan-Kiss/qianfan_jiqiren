const { isUiNoise } = require('./doudian-ui-noise-filter');
const { pickFirst } = require('./doudian-shop-utils');

const DOM_MESSAGE_SELECTOR_RE =
  /conversation|message|chat|bubble|im-msg|msg-list|msg_item|chat-item|session/i;

const DOM_FORBIDDEN_SELECTOR_RE =
  /nav|menu|sidebar|header|toolbar|tab-bar|button|footer|setting/i;

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isDomMessageSelector(selectorHint = '') {
  const s = String(selectorHint || '');
  if (!s) return false;
  if (DOM_FORBIDDEN_SELECTOR_RE.test(s)) return false;
  return DOM_MESSAGE_SELECTOR_RE.test(s);
}

function extractText(item = {}) {
  return normalizeText(
    pickFirst(item.text, item.content, item.msg, item.message, item.lastMessageText, item.last_message)
  );
}

function isRealBuyerMessage(item = {}, context = {}) {
  const text = extractText(item);
  if (!text || isUiNoise(text)) return false;

  const conversationId = pickFirst(
    item.conversationId,
    item.conversation_id,
    item.conversation_short_id
  );
  const buyerId = pickFirst(item.buyerId, item.buyer_id, item.userId, item.user_id);
  const messageId = pickFirst(item.messageId, item.message_id, item.serverMessageId);
  const source = context.source || '';
  const apiName = context.apiName || '';

  if (source === 'dom') {
    if (!isDomMessageSelector(context.selectorHint)) return false;
    return Boolean((conversationId || buyerId) && text);
  }

  if (source === 'conversation_list' || apiName === 'get_current_conversation_list') {
    return Boolean((conversationId || buyerId) && text);
  }

  if (source === 'link_info' || apiName === 'get_link_info') {
    return Boolean((messageId || conversationId) && text);
  }

  if (source === 'stdout') {
    return Boolean((conversationId || buyerId || messageId) && text);
  }

  // memory_cache / pigeon / ipc
  return Boolean((conversationId || buyerId) && text);
}

function toNormalizedMessage(item, shopInfo = {}, meta = {}) {
  const text = extractText(item);
  const direction = String(item.direction || 'buyer').toLowerCase();
  return {
    platform: 'doudian',
    shopId: pickFirst(shopInfo.shopId, item.shopId),
    shopName: pickFirst(shopInfo.shopName, item.shopName),
    conversationId: pickFirst(item.conversationId, item.conversation_id),
    buyerId: pickFirst(item.buyerId, item.buyer_id, item.userId, item.user_id),
    buyerName: pickFirst(item.buyerName, item.nickName, item.nickname, item.name),
    messageId: pickFirst(item.messageId, item.message_id, item.serverMessageId),
    direction: direction === 'seller' || direction === 'outbound' ? 'outbound' : 'inbound',
    messageType: item.messageType || 'text',
    text,
    timestamp: Number(item.timestamp || item.lastMessageTime || item.sendTime || Date.now()),
    rawTextHash: item.rawTextHash || '',
    source: meta.source || 'memory_cache',
    bridgeId: meta.bridgeId || '',
    pageHref: meta.pageHref || '',
    accountId: pickFirst(shopInfo.accountId, item.accountId),
    sessionPartitionKey: pickFirst(shopInfo.sessionPartitionKey, item.sessionPartitionKey),
    raw: {},
  };
}

module.exports = {
  isDomMessageSelector,
  isRealBuyerMessage,
  toNormalizedMessage,
  extractText,
};
