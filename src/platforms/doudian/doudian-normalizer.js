const { PLATFORM } = require('./doudian-types');
const { redactPayload } = require('../../shared/sensitive-redact');
const { getDoudianConfig } = require('../../shared/config');
const { pickFirst, hashText } = require('./doudian-shop-utils');

function normalizeDirection(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'inbound' || v === 'buyer' || v === 'user' || v === 'customer') return 'buyer';
  if (v === 'outbound' || v === 'seller' || v === 'shop' || v === 'merchant') return 'seller';
  return v || 'unknown';
}

function normalizeInboundMessage(envelope) {
  const cfg = getDoudianConfig();
  const payload = envelope.payload || {};
  const raw = envelope.raw || payload || {};
  const message = payload.message || raw.message || payload;

  const direction = normalizeDirection(pickFirst(payload.direction, raw.direction, message.direction));
  const text = pickFirst(payload.text, raw.text, raw.content, raw.message, message.text, message.content);

  const normalized = {
    platform: PLATFORM,
    shopId: pickFirst(envelope.shopId, payload.shopId, raw.shopId, message.shopId),
    shopName: pickFirst(envelope.shopName, payload.shopName, raw.shopName, message.shopName),
    accountId: pickFirst(payload.accountId, raw.accountId, message.accountId),
    sessionPartitionKey: pickFirst(payload.sessionPartitionKey, raw.sessionPartitionKey, message.sessionPartitionKey),
    conversationId: pickFirst(
      envelope.conversationId,
      payload.conversationId,
      raw.conversationId,
      raw.sessionId,
      raw.chatId,
      message.conversationId
    ),
    buyerId: pickFirst(envelope.buyerId, payload.buyerId, raw.buyerId, raw.userId, raw.uid, message.buyerId),
    buyerName: pickFirst(payload.buyerName, raw.buyerName, raw.nickName, raw.nickname, message.buyerName),
    messageId: pickFirst(envelope.messageId, payload.messageId, raw.messageId, raw.msgId, raw.id, message.messageId),
    direction,
    messageType: pickFirst(payload.messageType, raw.messageType, raw.type, message.messageType) || 'text',
    text,
    imageUrl: pickFirst(payload.imageUrl, raw.imageUrl, raw.image_url),
    orderId: pickFirst(payload.orderId, raw.orderId, raw.order_id),
    aftersaleId: pickFirst(payload.aftersaleId, raw.aftersaleId, raw.refundId, raw.afterSaleId),
    timestamp: Number(envelope.timestamp || payload.timestamp || raw.timestamp || message.timestamp || Date.now()),
    bridgeId: envelope.bridgeId || payload.bridgeId || raw.bridgeId || '',
    pageHref: pickFirst(payload.pageHref, payload.href, raw.pageHref, raw.href),
    source: pickFirst(payload.source, raw.source, message.source) || 'bridge',
    rawTextHash: pickFirst(payload.rawTextHash, raw.rawTextHash) || hashText(text),
    raw: cfg.debugRawPayload ? redactPayload(raw, cfg.redactSensitiveFields) : {},
  };

  return normalized;
}

function normalizeAftersaleEvent(envelope) {
  const payload = envelope.payload || {};
  return {
    type: envelope.type,
    platform: PLATFORM,
    aftersaleId: pickFirst(payload.aftersaleId, envelope.aftersaleId),
    orderId: pickFirst(payload.orderId, envelope.orderId),
    conversationId: pickFirst(payload.conversationId, envelope.conversationId),
    buyerId: pickFirst(payload.buyerId, envelope.buyerId),
    status: pickFirst(payload.status),
    reason: pickFirst(payload.reason),
    amount: pickFirst(payload.amount),
    deadline: pickFirst(payload.deadline),
    text: pickFirst(payload.text),
    timestamp: Number(payload.timestamp || envelope.timestamp || Date.now()),
    bridgeId: envelope.bridgeId || '',
    shopId: pickFirst(envelope.shopId, payload.shopId),
    shopName: pickFirst(envelope.shopName, payload.shopName),
  };
}

function normalizeOrderContext(envelope) {
  const payload = envelope.payload || {};
  return {
    platform: PLATFORM,
    orderId: pickFirst(payload.orderId, envelope.orderId),
    productTitle: pickFirst(payload.productTitle),
    sku: pickFirst(payload.sku),
    price: pickFirst(payload.price),
    quantity: pickFirst(payload.quantity),
    payTime: pickFirst(payload.payTime),
    orderStatus: pickFirst(payload.orderStatus),
    logisticsStatus: pickFirst(payload.logisticsStatus),
    aftersaleStatus: pickFirst(payload.aftersaleStatus),
    conversationId: pickFirst(payload.conversationId, envelope.conversationId),
    buyerId: pickFirst(payload.buyerId, envelope.buyerId),
    timestamp: Number(payload.timestamp || envelope.timestamp || Date.now()),
    bridgeId: envelope.bridgeId || '',
    shopId: pickFirst(envelope.shopId, payload.shopId),
    shopName: pickFirst(envelope.shopName, payload.shopName),
  };
}

function normalizeConversation(envelope) {
  const payload = envelope.payload || {};
  return {
    platform: PLATFORM,
    shopId: pickFirst(envelope.shopId, payload.shopId),
    shopName: pickFirst(envelope.shopName, payload.shopName),
    conversationId: pickFirst(envelope.conversationId, payload.conversationId),
    buyerId: pickFirst(envelope.buyerId, payload.buyerId),
    buyerName: pickFirst(payload.buyerName),
    lastMessage: pickFirst(payload.lastMessage, payload.text),
    lastMessageAt: Number(payload.lastMessageAt || envelope.timestamp || Date.now()),
    unreadCount: Number(payload.unreadCount || 0),
    takeoverStatus: pickFirst(payload.takeoverStatus) || 'auto',
  };
}

module.exports = {
  normalizeInboundMessage,
  normalizeAftersaleEvent,
  normalizeOrderContext,
  normalizeConversation,
  normalizeDirection,
};
