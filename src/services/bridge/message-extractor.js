const { bridgeLog } = require('../../shared/bridge-log');

const FIELD_CANDIDATES = {
  msgId: ['msgId', 'msg_id', 'messageId', 'message_id', 'id'],
  appCid: ['appCid', 'app_cid', 'appcid'],
  conversationId: ['conversationId', 'conversation_id', 'convId', 'conv_id', 'cid'],
  buyerId: ['buyerId', 'buyer_id', 'userId', 'user_id', 'uid'],
  sender: ['sender', 'from', 'fromUser', 'from_user', 'role'],
  content: ['content', 'text', 'body', 'message', 'msg'],
  messageType: ['messageType', 'message_type', 'type', 'msgType'],
  timestamp: ['timestamp', 'time', 'createTime', 'create_time', 'ts'],
};

function tryParseJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function pickField(obj, names) {
  if (!obj || typeof obj !== 'object') return '';
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null && String(obj[n]).trim() !== '') {
      return String(obj[n]);
    }
  }
  return '';
}

function walkForMessageObject(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = walkForMessageObject(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const content = pickField(node, FIELD_CANDIDATES.content);
  const msgId = pickField(node, FIELD_CANDIDATES.msgId);
  const conversationId = pickField(node, FIELD_CANDIDATES.conversationId);
  if (content && (msgId || conversationId || pickField(node, FIELD_CANDIDATES.buyerId))) {
    return node;
  }
  for (const k of Object.keys(node)) {
    const found = walkForMessageObject(node[k], depth + 1);
    if (found) return found;
  }
  return null;
}

class MessageExtractor {
  extract(frameRow) {
    const text = frameRow.payloadText || '';
    const parsed = tryParseJson(text);
    if (!parsed) {
      return {
        dedupeKey: `raw:${frameRow.dedupeKey}`,
        frameDedupeKey: frameRow.dedupeKey,
        raw: true,
        confidence: 0,
        direction: frameRow.direction,
        shopId: frameRow.shopId,
        shopName: frameRow.shopName,
        createdAt: new Date(frameRow.timestamp || Date.now()).toISOString(),
      };
    }

    const msgObj = walkForMessageObject(parsed) || parsed;
    const content = pickField(msgObj, FIELD_CANDIDATES.content);
    const msgId = pickField(msgObj, FIELD_CANDIDATES.msgId);
    const conversationId = pickField(msgObj, FIELD_CANDIDATES.conversationId);
    const buyerId = pickField(msgObj, FIELD_CANDIDATES.buyerId);
    const sender = pickField(msgObj, FIELD_CANDIDATES.sender);
    const messageType = pickField(msgObj, FIELD_CANDIDATES.messageType) || 'unknown';

    if (!content && !msgId && !conversationId) {
      return {
        dedupeKey: `raw:${frameRow.dedupeKey}`,
        frameDedupeKey: frameRow.dedupeKey,
        raw: true,
        confidence: 0.1,
        rawJson: JSON.stringify(parsed).slice(0, 5000),
        direction: frameRow.direction,
        shopId: frameRow.shopId,
        shopName: frameRow.shopName,
        createdAt: new Date(frameRow.timestamp || Date.now()).toISOString(),
      };
    }

    let confidence = 0.4;
    if (content) confidence += 0.2;
    if (msgId) confidence += 0.15;
    if (conversationId || buyerId) confidence += 0.15;
    if (sender) confidence += 0.1;

    const row = {
      dedupeKey: `biz:${frameRow.dedupeKey}`,
      frameDedupeKey: frameRow.dedupeKey,
      msgId,
      appCid: pickField(msgObj, FIELD_CANDIDATES.appCid),
      conversationId,
      buyerId,
      sender,
      direction: frameRow.direction,
      content: content.slice(0, 5000),
      messageType,
      rawJson: JSON.stringify(parsed).slice(0, 8000),
      confidence: Math.min(1, confidence),
      shopId: frameRow.shopId,
      shopName: frameRow.shopName,
      createdAt: new Date(frameRow.timestamp || Date.now()).toISOString(),
      raw: false,
    };

    bridgeLog('[MSG_EXTRACT]', `confidence=${row.confidence} type=${messageType} content=${content.slice(0, 40)}`);
    return row;
  }
}

module.exports = {
  MessageExtractor,
  tryParseJson,
  pickField,
};
