/**
 * 千帆纯协议 — 会话消息解析与分页
 */
const {
  buildBuyerMessage,
  deepParseJson,
  extractMessagesFromResponse,
  isSellerSideSender,
  normalizeQianfanMessage,
} = require('../chat-parse');

function extractAllChatMessages(body, shopTitle, source = 'protocol_http') {
  const parsed = deepParseJson(body);
  const rawList = extractMessagesFromResponse(parsed, shopTitle, source);
  const seen = new Set();
  const out = [];

  for (const msg of rawList) {
    const normalized = normalizeQianfanMessage(msg);
    const key = `${normalized.appCid}::${normalized.msgId}`;
    if (!normalized.msgId || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }

  // batch API: data.infos[appCid].userMessageInfos
  const infos = parsed?.data?.infos;
  if (infos && typeof infos === 'object') {
    for (const [appCid, block] of Object.entries(infos)) {
      const list = block?.userMessageInfos || block?.messages || [];
      for (const item of list) {
        const msg = buildBuyerMessage({
          shopTitle,
          item: { ...item, appCid: item.appCid || appCid },
          raw: item,
          source: `${source}:batch`,
        });
        const normalized = normalizeQianfanMessage(msg);
        normalized.isSellerSide = isSellerSideSender(normalized.senderType);
        const key = `${normalized.appCid}::${normalized.msgId}`;
        if (!normalized.msgId || seen.has(key)) continue;
        seen.add(key);
        out.push(normalized);
      }
    }
  }

  out.sort((a, b) => Number(a.createAt || 0) - Number(b.createAt || 0));
  return out;
}

function parseMessageListMeta(body) {
  const parsed = deepParseJson(body);
  const data = parsed?.data || {};
  return {
    hasMore: Boolean(data.hasMore),
    nextCursor: data.nextCursor != null ? Number(data.nextCursor) : -1,
    code: Number(parsed?.code ?? data.code ?? -1),
    msg: String(parsed?.msg || data.msg || ''),
    success: parsed?.code === 0 || parsed?.success === true || data.success === true,
  };
}

function discoverSessionsFromSnapshot(snapshot) {
  const map = new Map();
  const add = (row) => {
    const appCid = String(row?.appCid || '').trim();
    if (!appCid) return;
    const prev = map.get(appCid) || {};
    map.set(appCid, {
      appCid,
      buyerNick: row.buyerNick || prev.buyerNick || '',
      receiverAppUids: row.receiverAppUids || prev.receiverAppUids || [],
      lastBuyerText: row.lastBuyerText || prev.lastBuyerText || '',
      lastBuyerMsgAt: row.lastBuyerMsgAt || prev.lastBuyerMsgAt || 0,
      source: row.source || prev.source || 'snapshot',
    });
  };

  for (const ctx of snapshot?.sessionContexts || []) {
    add({
      appCid: ctx.appCid,
      buyerNick: ctx.buyerNick,
      receiverAppUids: ctx.receiverAppUids,
      lastBuyerText: ctx.lastBuyerText,
      lastBuyerMsgAt: ctx.lastBuyerMsgAt,
      source: 'sessionContext',
    });
  }

  for (const row of snapshot?.receiverCache || []) {
    const appCid = String(row?.key || '').split('::').pop();
    add({ appCid, receiverAppUids: row.receiverAppUids, source: 'receiverCache' });
  }

  for (const ws of snapshot?.wsCandidates || []) {
    for (const appCid of ws?.appCids || []) {
      add({ appCid, source: 'wsCandidate' });
    }
  }

  const manual = snapshot?.lastManualSendByAppCid || {};
  for (const [appCid, sample] of Object.entries(manual)) {
    add({
      appCid,
      receiverAppUids: sample?.payload?.body?.receiverAppUids,
      source: 'manualSend',
    });
  }

  return [...map.values()];
}

module.exports = {
  extractAllChatMessages,
  parseMessageListMeta,
  discoverSessionsFromSnapshot,
};
