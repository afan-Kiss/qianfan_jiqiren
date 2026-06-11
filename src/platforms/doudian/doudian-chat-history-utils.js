const { pickFirst, hashText, maskMessageForReport } = require('./doudian-shop-utils');
const { isUiNoise } = require('./doudian-ui-noise-filter');
const { normalizeMessage } = require('./doudian-pigeon-parser');

function normalizeDirection(direction) {
  const d = String(direction || '').toLowerCase();
  if (d === 'seller' || d === 'outbound' || d === 'service' || d === 'shop') return 'seller';
  if (d === 'buyer' || d === 'inbound' || d === 'customer' || d === 'user') return 'buyer';
  return 'unknown';
}

function isHistoryMessageItem(item = {}) {
  const text = String(item.text || item.content || '').trim();
  const messageId = pickFirst(item.messageId, item.message_id, item.serverMessageId);
  const conversationId = pickFirst(item.conversationId, item.conversation_id);
  const buyerId = pickFirst(item.buyerId, item.buyer_id, item.userId, item.uid);
  if (text && isUiNoise(text)) return false;
  if (messageId) return true;
  if ((conversationId || buyerId) && text) return true;
  if (text && text.length >= 2) return true;
  return false;
}

function toHistoryPlatformMessage(item, shopInfo = {}, meta = {}) {
  const normalized = normalizeMessage(item, shopInfo) || {};
  const text = pickFirst(normalized.text, item.text, item.content).slice(0, 1000);
  const direction = normalizeDirection(pickFirst(normalized.direction, item.direction));
  const messageType = pickFirst(normalized.messageType, item.messageType, 'text');
  const timestamp = Number(
    pickFirst(normalized.timestamp, item.timestamp, item.sendTime, item.createTime) || Date.now()
  );

  return {
    platform: 'doudian',
    shopId: pickFirst(shopInfo.shopId, normalized.shopId, item.shopId),
    shopName: pickFirst(shopInfo.shopName, normalized.shopName, item.shopName),
    accountId: pickFirst(shopInfo.accountId, item.accountId),
    sessionPartitionKey: pickFirst(shopInfo.sessionPartitionKey, item.sessionPartitionKey),
    conversationId: pickFirst(
      meta.conversationId,
      normalized.conversationId,
      item.conversationId,
      item.conversation_id
    ),
    buyerId: pickFirst(meta.buyerId, normalized.buyerId, item.buyerId, item.userId, item.uid),
    buyerName: pickFirst(meta.buyerName, normalized.buyerName, item.buyerName, item.nickName),
    messageId: pickFirst(normalized.messageId, item.messageId, item.message_id),
    direction,
    directionConfidence: Number(item.directionConfidence || normalized.directionConfidence || 0),
    directionReasons: Array.isArray(item.directionReasons) ? item.directionReasons : [],
    conversationIdSource: pickFirst(meta.conversationIdSource, item.conversationIdSource),
    messageType,
    text,
    timestamp,
    rawTextHash: normalized.rawTextHash || hashText(text || pickFirst(normalized.messageId, 'na')),
    source: meta.source || 'memory_cache',
    bridgeId: meta.bridgeId || '',
    pageHref: meta.pageHref || '',
    raw: item,
  };
}

function countHistoryDirections(messages = []) {
  let realBuyerMessageCount = 0;
  let sellerMessageCount = 0;
  let unknownCount = 0;
  for (const msg of messages) {
    const d = normalizeDirection(msg.direction);
    if (d === 'buyer') realBuyerMessageCount += 1;
    else if (d === 'seller') sellerMessageCount += 1;
    else unknownCount += 1;
  }
  return { realBuyerMessageCount, sellerMessageCount, unknownCount };
}

function maskHistorySamples(messages = [], limit = 10) {
  return messages.slice(0, limit).map((m) => ({
    ...maskMessageForReport(m),
    directionConfidence: Number(m.directionConfidence || 0),
    directionReasons: Array.isArray(m.directionReasons) ? m.directionReasons.slice(0, 5) : [],
    conversationIdSource: m.conversationIdSource || '',
  }));
}

module.exports = {
  normalizeDirection,
  isHistoryMessageItem,
  toHistoryPlatformMessage,
  countHistoryDirections,
  maskHistorySamples,
};
