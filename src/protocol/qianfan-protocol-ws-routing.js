/**
 * 千帆纯协议 WS 通道路由
 * - apppush-wss：auth 后可直接 /message/send（tap 实测 2026-07）+ ping/推送
 * - walle/edith impaas/longlink?token=...：/message/send（无 auth 帧）
 */

function shopTitleMatches(rowTitle, shopTitle) {
  if (!shopTitle) return true;
  if (!rowTitle) return false;
  const a = String(rowTitle).trim();
  const b = String(shopTitle).trim();
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

function isApppushWsUrl(url) {
  return /apppush/i.test(String(url || ''));
}

function isImpaasSendWsUrl(url) {
  const u = String(url || '').trim();
  if (!u || !/^wss?:\/\//i.test(u)) return false;
  if (isApppushWsUrl(u)) return false;
  return /impaas|longlink/i.test(u);
}

function scoreWsUrlForProtocol(url) {
  const u = String(url || '');
  let score = 0;
  if (isImpaasSendWsUrl(u)) score += 300;
  if (/walle\.xiaohongshu\.com/i.test(u)) score += 120;
  if (/edith\.xiaohongshu\.com/i.test(u)) score += 80;
  if (/longlink/i.test(u)) score += 40;
  if (isApppushWsUrl(u)) score -= 80;
  return score;
}

function needsWsAuthHandshake(url) {
  return isApppushWsUrl(url);
}

function supportsImpaasMessageSend(url) {
  return isImpaasSendWsUrl(url);
}

/** apppush 鉴权后或 impaas token 链路上均可发 /message/send */
function supportsMessageSend(url) {
  return isImpaasSendWsUrl(url) || isApppushWsUrl(url);
}

function buildWsUrlByRequestId(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const reqId = String(row.requestId || '').trim();
    const url = String(row.url || row.wsUrl || '').trim();
    if (!reqId || !url) continue;
    if (row.kind === 'ws_created' || row.kind === 'ws_handshake') {
      map.set(reqId, url);
    }
    if (row.kind === 'ws_frame' && url) {
      map.set(reqId, url);
    }
  }
  return map;
}

function pickApppushSendWsUrlFromTap(rows, shopTitle = '') {
  const urlByReq = buildWsUrlByRequestId(rows);
  let best = '';
  for (const row of rows || []) {
    if (row.kind !== 'ws_frame' || row.direction !== 'sent') continue;
    if (row.action !== '/message/send' || Number(row.type) !== 3) continue;
    if (shopTitle && row.shopTitle && !shopTitleMatches(row.shopTitle, shopTitle)) continue;
    const wsUrl =
      String(row.wsUrl || '').trim() || urlByReq.get(String(row.requestId || '')) || '';
    if (isApppushWsUrl(wsUrl)) best = wsUrl;
  }
  return best;
}

function pickMaxWsSeqFromTap(rows, shopTitle = '') {
  let max = 0;
  for (const row of rows || []) {
    if (row.kind !== 'ws_frame') continue;
    if (shopTitle && row.shopTitle && !shopTitleMatches(row.shopTitle, shopTitle)) continue;
    const seq = Number(row.payloadJson?.header?.seq || row.seq || 0);
    if (seq > max) max = seq;
  }
  return max;
}

function pickImpaasSendWsUrlFromTap(rows, shopTitle = '') {
  let best = '';
  let bestScore = -1;
  const consider = (url, bonus = 0) => {
    const u = String(url || '').trim();
    if (!isImpaasSendWsUrl(u)) return;
    const score = scoreWsUrlForProtocol(u) + bonus;
    if (score > bestScore) {
      bestScore = score;
      best = u;
    }
  };

  for (const row of rows || []) {
    if (shopTitle && row.shopTitle && !shopTitleMatches(row.shopTitle, shopTitle)) continue;
    if (row.kind === 'ws_created' || row.kind === 'ws_handshake') {
      consider(row.url, row.kind === 'ws_created' ? 20 : 10);
      continue;
    }
    if (row.kind === 'ws_frame' && row.action === '/message/send' && row.direction === 'sent') {
      consider(row.wsUrl, 200);
    }
  }
  return best;
}

function pickApppushWsUrlFromTap(rows, shopTitle = '') {
  for (const row of rows || []) {
    if (row.kind !== 'ws_created' && row.kind !== 'ws_handshake') continue;
    if (shopTitle && row.shopTitle && !shopTitleMatches(row.shopTitle, shopTitle)) continue;
    const url = String(row.url || '');
    if (isApppushWsUrl(url)) return url;
  }
  return '';
}

function resolveProtocolWsEndpoints(shopConfig = {}, tapRows = []) {
  const ws = shopConfig.ws || {};
  const fromTapSend = pickImpaasSendWsUrlFromTap(tapRows, shopConfig.shopTitle);
  const fromTapApppushSend = pickApppushSendWsUrlFromTap(tapRows, shopConfig.shopTitle);
  const fromTapApppush = pickApppushWsUrlFromTap(tapRows, shopConfig.shopTitle);
  const manualSendUrl = String(shopConfig.wsUrlFromManualSend || '').trim();

  const sendCandidates = [
    ws.sendUrl,
    ws.impaasUrl,
    manualSendUrl,
    isImpaasSendWsUrl(ws.url) ? ws.url : '',
    isApppushWsUrl(manualSendUrl) ? manualSendUrl : '',
    fromTapSend,
    fromTapApppushSend,
  ]
    .map((u) => String(u || '').trim())
    .filter(Boolean);

  let sendUrl =
    sendCandidates.sort((a, b) => scoreWsUrlForProtocol(b) - scoreWsUrlForProtocol(a))[0] || '';

  const apppushUrl =
    String(ws.apppushUrl || '').trim() ||
    (isApppushWsUrl(ws.url) ? ws.url : '') ||
    fromTapApppushSend ||
    fromTapApppush ||
    String(ws.listenUrl || '').trim();

  if (!sendUrl && fromTapApppushSend) sendUrl = fromTapApppushSend;
  if (!sendUrl && isApppushWsUrl(apppushUrl) && manualSendUrl && isApppushWsUrl(manualSendUrl)) {
    sendUrl = apppushUrl;
  }

  const listenUrl =
    (isImpaasSendWsUrl(sendUrl) ? '' : sendUrl) ||
    sendUrl ||
    apppushUrl ||
    String(ws.url || '').trim();

  return {
    sendUrl,
    listenUrl,
    apppushUrl,
    canSend: Boolean(sendUrl && supportsMessageSend(sendUrl)),
    listenNeedsAuth: needsWsAuthHandshake(listenUrl),
    sendNeedsAuth: needsWsAuthHandshake(sendUrl),
    sendViaApppush: Boolean(sendUrl && isApppushWsUrl(sendUrl)),
  };
}

function formatMissingSendUrlError() {
  return (
    '纯 WS 发送缺少可用 send URL：需 tap 捕获 /message/send（apppush 鉴权后或 impaas/longlink?token=...）。' +
    '请在客服台向饭饭发一条消息后重试 qf:protocol:tap:auto。'
  );
}

module.exports = {
  shopTitleMatches,
  isApppushWsUrl,
  isImpaasSendWsUrl,
  scoreWsUrlForProtocol,
  needsWsAuthHandshake,
  supportsImpaasMessageSend,
  supportsMessageSend,
  buildWsUrlByRequestId,
  pickMaxWsSeqFromTap,
  pickImpaasSendWsUrlFromTap,
  pickApppushSendWsUrlFromTap,
  pickApppushWsUrlFromTap,
  resolveProtocolWsEndpoints,
  formatMissingSendUrlError,
};
