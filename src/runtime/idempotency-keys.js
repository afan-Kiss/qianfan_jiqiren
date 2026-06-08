const crypto = require('crypto');
const { contentHashForDedup, buildCanonicalBuyerMessageKey } = require('../qianfan-data-store');

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

function normalizeReplyTextForDedup(text = '', replyId = '') {
  const raw = String(text || '').trim();
  if (/^#\d+\s/.test(raw)) {
    const stripped = raw.replace(/\s+长跑模拟回复\s+wx-reply-[^\s]+$/i, '').trim();
    return stripped || `#${replyId}`;
  }
  if (/^长跑模拟回复\s+wx-reply-/i.test(raw) && replyId !== '' && replyId !== undefined && replyId !== null) {
    return `#${replyId}`;
  }
  const stripped = raw.replace(/\s+长跑模拟回复\s+wx-reply-[^\s]+$/i, '').trim();
  if (stripped) return stripped;
  if (replyId !== '' && replyId !== undefined && replyId !== null) return `#${replyId}`;
  return raw;
}

function buyerMessageKey(message = {}) {
  const shopId = message.shopId || message.shopTitle || message.appCid || '';
  const buyerId = message.buyerId || message.buyerNick || message.senderAppUid || '';
  const messageId = message.messageId || message.msgId || contentHashForDedup(message);
  return `buyer:${shopId}:${buyerId}:${messageId}`;
}

function buyerMessageKeyFromMessage(message) {
  const canonical = buildCanonicalBuyerMessageKey(message);
  if (canonical) return `buyer:${canonical}`;
  return buyerMessageKey(message);
}

function notificationSuccessKey({ replyId, receiverWxid }) {
  return `notify:${replyId}:${receiverWxid}`;
}

function wechatReplyKey({ fromWxid, msgId, text }) {
  const contentHash = msgId || hashText(text);
  return `wechat-reply:${fromWxid}:${contentHash}`;
}

function qianfanSendPendingKey({ replyId, replyText }) {
  const normalized = normalizeReplyTextForDedup(replyText, replyId);
  return `qianfan-send:${replyId}:${hashText(normalized)}`;
}

function qianfanSendSuccessKey({ replyId, replyText }) {
  const normalized = normalizeReplyTextForDedup(replyText, replyId);
  return `qianfan-send-success:${replyId}:${hashText(normalized)}`;
}

function failureReceiptKey({ replyId, replyText, receiverWxid, errorCodeOrType = 'unknown' }) {
  const normalized = normalizeReplyTextForDedup(replyText, replyId);
  const contentHash = hashText(normalized);
  return `failure-receipt:${replyId}:${contentHash}:${receiverWxid}:${errorCodeOrType}`;
}

function wechatReplyContentKey({ replyId, replyText }) {
  const normalized = normalizeReplyTextForDedup(replyText, replyId);
  return `wechat-reply-content:${replyId}:${hashText(normalized)}`;
}

module.exports = {
  buyerMessageKey,
  buyerMessageKeyFromMessage,
  notificationSuccessKey,
  wechatReplyKey,
  qianfanSendPendingKey,
  qianfanSendSuccessKey,
  failureReceiptKey,
  wechatReplyContentKey,
  normalizeReplyTextForDedup,
  hashText,
};
