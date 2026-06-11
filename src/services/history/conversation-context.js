const { HistoryDb } = require('./history-db');

let sharedDb = null;

function getSharedHistoryDb() {
  if (!sharedDb) sharedDb = new HistoryDb();
  return sharedDb;
}

function getConversationContext({ shopId, conversationId, limit = 20 } = {}) {
  const db = getSharedHistoryDb();
  const historyReady = db.getStatus('historyReady', 'false') === 'true';
  const historySyncStatus = db.getStatus('historySyncStatus', 'idle');

  if (!shopId || !conversationId) {
    return {
      historyReady: false,
      historySyncStatus,
      messages: [],
      reason: 'missing_shop_or_conversation',
    };
  }

  const rows = db.getRecentMessages({ shopId, conversationId, limit: Math.max(limit, 50) });
  const sorted = rows
    .sort((a, b) => String(a.send_time).localeCompare(String(b.send_time)))
    .slice(-limit);

  return {
    historyReady,
    historySyncStatus,
    shopId,
    conversationId,
    limit,
    messages: sorted.map((r) => ({
      msgId: r.msg_id,
      direction: r.direction,
      content: r.content,
      messageType: r.message_type,
      sendTime: r.send_time,
      buyerId: r.buyer_id,
      buyerName: r.buyer_name,
      source: r.source,
      confidence: r.confidence,
    })),
  };
}

module.exports = {
  getConversationContext,
  getSharedHistoryDb,
};
