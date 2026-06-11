const { parseChatHistoryPayload, resolveApiName } = require('../../platforms/doudian/doudian-pigeon-parser');
const { toHistoryPlatformMessage } = require('../../platforms/doudian/doudian-chat-history-utils');
const { classifyPagePlatform } = require('../../platforms/doudian/doudian-page-finder');
const { historyLog } = require('../../shared/history-log');

function normalizeDirection(raw) {
  const d = String(raw || '').toLowerCase();
  if (['buyer', 'inbound', 'customer', 'user'].includes(d)) return 'buyer';
  if (['seller', 'outbound', 'service', 'shop', 'staff'].includes(d)) return 'seller';
  if (['system', 'robot', 'auto'].includes(d)) return 'system';
  return 'unknown';
}

function normalizeHistoryMessage(item, meta = {}) {
  const platform = meta.platform || classifyPagePlatform(meta.target || {}) || 'doudian';
  const shopInfo = {
    shopId: meta.shopId || item.shopId || 'unknown',
    shopName: meta.shopName || item.shopName || 'unknown',
  };

  if (meta.source === 'history-api' && item && typeof item === 'object' && !item.raw) {
    const parsed = parseChatHistoryPayload(item, shopInfo, meta);
    if (parsed.messages?.length === 1) {
      item = parsed.messages[0];
    }
  }

  const base = toHistoryPlatformMessage(item, shopInfo, {
    source: meta.source || 'history-api',
    conversationId: meta.conversationId,
    buyerId: meta.buyerId,
    buyerName: meta.buyerName,
  });

  const row = {
    platform: platform === 'doudian' ? 'doudian' : platform === 'qianfan' ? 'qianfan' : 'unknown',
    shopId: base.shopId || shopInfo.shopId,
    shopName: base.shopName || shopInfo.shopName,
    conversationId: base.conversationId || meta.conversationId || '',
    buyerId: base.buyerId || meta.buyerId || '',
    buyerName: base.buyerName || meta.buyerName || '',
    msgId: base.messageId || '',
    direction: normalizeDirection(base.direction),
    content: base.text || '',
    messageType: base.messageType || 'text',
    sendTime: base.timestamp ? new Date(base.timestamp).toISOString() : new Date().toISOString(),
    raw: item,
    source: meta.source || 'history-api',
    confidence: Number(meta.confidence || base.directionConfidence || 0.5),
  };

  if (!row.content && !row.msgId && !row.conversationId) {
    row.confidence = 0.1;
  }

  historyLog('[HISTORY_NORMALIZE]', `dir=${row.direction} conf=${row.confidence} len=${row.content.length}`);
  return row;
}

function normalizeConversationList(payload, meta = {}) {
  const shopInfo = { shopId: meta.shopId || 'unknown', shopName: meta.shopName || 'unknown' };
  const parsed = parseChatHistoryPayload(payload, shopInfo, meta);
  const conversations = [];

  if (Array.isArray(parsed.conversations)) {
    for (const c of parsed.conversations) {
      conversations.push({
        platform: meta.platform || 'doudian',
        shopId: shopInfo.shopId,
        shopName: shopInfo.shopName,
        conversationId: c.conversationId || c.conversation_id || '',
        buyerId: c.buyerId || c.buyer_id || '',
        buyerName: c.buyerName || c.buyer_name || c.nickName || '',
        lastMessageTime: c.lastMessageTime || c.timestamp || '',
        content: c.content || c.text || c.lastMessage || '',
        source: meta.source || 'history-api',
        rawJson: JSON.stringify(c).slice(0, 4000),
      });
    }
  }

  if (!conversations.length && parsed.conversationId) {
    conversations.push({
      platform: meta.platform || 'doudian',
      shopId: shopInfo.shopId,
      shopName: shopInfo.shopName,
      conversationId: parsed.conversationId,
      buyerId: parsed.buyerId || '',
      buyerName: parsed.buyerName || '',
      lastMessageTime: '',
      content: '',
      source: meta.source || 'history-api',
      rawJson: '',
    });
  }

  return { conversations, messages: parsed.messages || [], apiName: parsed.apiName || resolveApiName(meta.url) };
}

function normalizeBatch(items, meta = {}) {
  const rows = [];
  for (const item of items || []) {
    try {
      rows.push(normalizeHistoryMessage(item, meta));
    } catch (err) {
      historyLog('[HISTORY_ERROR]', 'normalize item failed', String(err.message || err));
    }
  }
  return rows;
}

module.exports = {
  normalizeHistoryMessage,
  normalizeConversationList,
  normalizeBatch,
  normalizeDirection,
};
