/**
 * 千帆店铺页 WebSocket 桥接：注册 CDP、发送 /message/send、严格 ACK 确认
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./wechat/wxbot-new-config');
const {
  parseMaybeJson,
  parseWsSessionMessages,
  parseWsBuyerMessage,
  extractBuyerMessagesFromWsPayload,
  extractMessagesFromResponse,
} = require('./chat-parse');

const HTTP_CAPTURE_PATHS = [
  '/api/impaas/message/user/list/batch',
  '/api/impaas/message/user/list',
  '/api/edith/cs/pc/message/latest/content',
  '/api/edith/cs/seller/get/unchecked/ai/msg',
];

function matchHttpCapturePath(url) {
  const u = String(url || '');
  return HTTP_CAPTURE_PATHS.find((p) => u.includes(p)) || '';
}

function captureHttpTemplate(bridge, request) {
  const url = String(request?.url || '');
  const pathKey = matchHttpCapturePath(url);
  if (!pathKey) return;

  const headers = { ...(request.headers || {}) };
  delete headers.Cookie;
  delete headers.cookie;
  const tpl = {
    pathKey,
    url,
    method: request.method || 'POST',
    headers,
    bodyTemplate: request.postData || '',
  };
  bridge.httpTemplates.set(pathKey, tpl);
  if (pathKey.includes('/api/impaas/message/user/list')) {
    bridge.lastMessageListRequest = tpl;
  }
}
const { buildTextSendPayloadFromContext } = require('./qf-send-payload');
const { getSessionContext } = require('./qianfan-data-store');
const { syncQianfanConversationUi, installUiSyncBridge } = require('./qianfan-ui-sync');
const { println } = require('./utils');
const { cdpRuntimeEvaluate, withTimeout, cdpAddScriptToEvaluateOnNewDocument, cdpNetworkEnable, cdpNetworkDisable } = require('./cdp-timeout');

const bridges = new Map();
const shopWakeReconnect = new Map();
const IMPAAS_WAKE_WAIT_MS = 800;
const IMPAAS_RECONNECT_WAIT_MS = 3500;
const ACK_TIMEOUT_MS = 8000;
const ECHO_VERIFY_MS = 10000;
const UI_SYNC_TIMEOUT_MS = 12000;

const WS_HOOK_SCRIPT = `(function(){
  window.__qfImpaasSockets = (window.__qfImpaasSockets || []).filter(function(w){ return w && w.readyState === 1; });
  if (window.__qfBridgeHooked) {
    return { ok: true, already: true, count: window.__qfImpaasSockets.length };
  }
  window.__qfBridgeHooked = true;
  function track(ws) {
    try {
      if (!ws || ws.readyState !== 1) return;
      const u = String(ws.url || '');
      if (u.includes('longlink') || u.includes('impaas') || u.includes('walle') || u.includes('xiaohongshu') || u.includes('edith')) {
        if (!window.__qfImpaasSockets.includes(ws)) window.__qfImpaasSockets.push(ws);
        if (u.includes('longlink')) ws.__qfSendRank = Math.max(ws.__qfSendRank || 0, 10);
      }
    } catch (e) {}
  }
  window.__qfPickSendSocket = function(appCid) {
    const list = (window.__qfImpaasSockets || []).filter(function(w){ return w && w.readyState === 1; });
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < list.length; i++) {
      var ws = list[i];
      var score = ws.__qfSendRank || 0;
      if (appCid && ws.__qfAppCids && ws.__qfAppCids.indexOf(appCid) >= 0) score += 1000;
      if (score > bestScore) { bestScore = score; best = ws; }
    }
    if (!best) return { ok: false, count: list.length };
    return { ok: true, url: String(best.url || ''), score: bestScore };
  };
  var Orig = WebSocket;
  function PatchedWebSocket(url, protocols) {
    var ws = protocols !== undefined ? new Orig(url, protocols) : new Orig(url);
    track(ws);
    return ws;
  }
  PatchedWebSocket.prototype = Orig.prototype;
  Object.setPrototypeOf(PatchedWebSocket, Orig);
  window.WebSocket = PatchedWebSocket;
  if (!WebSocket.prototype.__qfSendHooked) {
    WebSocket.prototype.__qfSendHooked = true;
    var origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedSend(data) {
      track(this);
      try {
        var s = String(data || '');
        if (s.indexOf('/message/send') >= 0 && s.indexOf('impaas.oi') >= 0) {
          this.__qfSendRank = (this.__qfSendRank || 0) + 100;
          var m = s.match(/"appCid"\\s*:\\s*"([^"\\\\]+)"/);
          if (m && m[1]) {
            this.__qfAppCids = this.__qfAppCids || [];
            if (this.__qfAppCids.indexOf(m[1]) < 0) this.__qfAppCids.push(m[1]);
          }
        } else if (s.indexOf('/message/read/from/one') >= 0) {
          this.__qfSendRank = (this.__qfSendRank || 0) + 1;
        }
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
  }
  return { ok: true };
})()`;

function debugDir() {
  const dir = path.join(config.root, 'logs', 'debug');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function datedLogPath(prefix) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(debugDir(), `${prefix}-${y}-${m}-${day}.jsonl`);
}

function appendJsonl(filePath, entry) {
  fs.appendFileSync(filePath, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

function writeSendDebug(entry) {
  appendJsonl(datedLogPath('qianfan-send-debug'), entry);
}

function writeManualSendSample(entry) {
  appendJsonl(datedLogPath('qianfan-manual-send-sample'), entry);
}

function writeBotSendSample(entry) {
  appendJsonl(datedLogPath('qianfan-bot-send-sample'), entry);
}

function normalizeShopKey(title) {
  return String(title || '')
    .replace(/-工作台\s*$/i, '')
    .trim();
}

function makeTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

function makeSMid() {
  return `${crypto.randomBytes(6).toString('hex')}-${Date.now().toString(16).slice(-12)}`;
}

function makeUuid() {
  return `text-${crypto.randomBytes(8).toString('hex')}-${Date.now().toString(16)}`;
}

function noteSeqHolder(holder, parsed) {
  const seq = Number(parsed?.header?.seq || 0);
  if (seq > holder.lastSeq) holder.lastSeq = seq;
}

function summarizeBody(body) {
  if (!body || typeof body !== 'object') return body;
  return {
    appCid: body.appCid,
    receiverAppUids: body.receiverAppUids,
    contentInfo: body.contentInfo,
    extension: body.extension,
    uuid: body.uuid,
    convType: body.convType,
  };
}

function comparePayloadSummary(manual, bot) {
  const diffs = [];
  const fields = ['appCid', 'receiverAppUids', 'contentInfo', 'extension', 'uuid'];
  for (const f of fields) {
    const a = JSON.stringify(manual?.[f] ?? null);
    const b = JSON.stringify(bot?.[f] ?? null);
    if (a !== b) diffs.push({ field: f, manual: manual?.[f] ?? null, bot: bot?.[f] ?? null });
  }
  return diffs;
}

function printPayloadDiff(manualBody, botBody) {
  const diffs = comparePayloadSummary(manualBody, botBody);
  if (!diffs.length) {
    println('[千帆对比] 机器人 payload 与最近手动发送一致（核心字段）');
    return;
  }
  println('[千帆对比] 手动发送 payload 与机器人发送 payload 差异：');
  for (const d of diffs) {
    println(`- ${d.field}: 手动=${JSON.stringify(d.manual)} 机器人=${JSON.stringify(d.bot)}`);
  }
}

function captureManualSend(bridge, parsed, requestId) {
  const body = parsed?.body || {};
  const appCid = String(body.appCid || '').trim();
  if (!appCid) return;

  const sample = {
    shopTitle: normalizeShopKey(bridge.shopTitle),
    requestId,
    appCid,
    receiverAppUids: body.receiverAppUids,
    payload: parsed,
    bodySummary: summarizeBody(body),
  };

  bridge.lastManualSendByAppCid.set(appCid, sample);
  bridge.lastManualSendAny = sample;
  writeManualSendSample(sample);
}

function noteWsFrame(bridge, requestId, parsed, direction) {
  if (!parsed) return;

  if (!bridge.wsSessions.has(requestId)) {
    bridge.wsSessions.set(requestId, {
      requestId,
      url: bridge.wsUrls.get(requestId) || '',
      seenMessageSend: false,
      seenReadFromOne: false,
      seenBuyerSync: false,
      seenImpaasTraffic: false,
      appCids: new Set(),
      lastSeq: 0,
      lastManualSendAt: 0,
      lastActivityAt: 0,
    });
  }

  const sess = bridge.wsSessions.get(requestId);
  sess.lastActivityAt = Date.now();
  noteSeqHolder(sess, parsed);

  const hdr = parsed.header || {};
  const body = parsed.body || {};
  const action = hdr.action || '';
  const serviceId = String(hdr.serviceId || '');

  if (body.appCid) sess.appCids.add(String(body.appCid));

  if (
    serviceId.includes('impaas') ||
    action.includes('/message/') ||
    action === '/sync/unreliable'
  ) {
    sess.seenImpaasTraffic = true;
  }

  if (action === '/sync/unreliable') {
    sess.seenBuyerSync = true;
    try {
      const buyerMsgs = parseWsBuyerMessage(parsed, bridge.shopTitle);
      for (const m of buyerMsgs) {
        if (m.appCid) sess.appCids.add(String(m.appCid));
      }
      const allMsgs = parseWsSessionMessages(parsed, bridge.shopTitle);
      for (const m of allMsgs) {
        if (m.appCid) sess.appCids.add(String(m.appCid));
      }
    } catch {
      // ignore
    }
  }

  if (direction === 'sent' && action === '/message/send' && Number(hdr.type) === 3 && serviceId === 'impaas.oi') {
    sess.seenMessageSend = true;
    sess.lastManualSendAt = Date.now();
    captureManualSend(bridge, parsed, requestId);
  }

  if (action === '/message/read/from/one') {
    sess.seenReadFromOne = true;
  }

  noteSeqHolder(bridge, parsed);
}

function scoreSendSession(sess, appCid) {
  let sc = 0;
  const hasCid = sess.appCids.has(appCid);
  if (hasCid && sess.seenMessageSend) sc += 500;
  if (hasCid && sess.seenBuyerSync) sc += 400;
  if (hasCid) sc += 200;
  if (sess.seenMessageSend) sc += 150;
  if (sess.seenBuyerSync) sc += 120;
  if (sess.seenImpaasTraffic) sc += 80;
  if (sess.seenReadFromOne) sc += 30;
  sc += Math.min(sess.lastSeq, 50);
  return sc;
}

function isImpaasWsSession(sess, bridge) {
  const url = String(sess.url || bridge.wsUrls.get(sess.requestId) || '').toLowerCase();
  return (
    url.includes('longlink') ||
    url.includes('impaas') ||
    url.includes('walle') ||
    url.includes('xiaohongshu') ||
    url.includes('edith') ||
    sess.seenImpaasTraffic ||
    sess.seenBuyerSync ||
    sess.seenMessageSend
  );
}

function pickSendSession(bridge, appCid) {
  const sessions = [...bridge.wsSessions.values()].filter((s) => isImpaasWsSession(s, bridge));
  if (!sessions.length) return null;

  sessions.sort(
    (a, b) =>
      scoreSendSession(b, appCid) - scoreSendSession(a, appCid) ||
      b.lastActivityAt - a.lastActivityAt ||
      b.lastSeq - a.lastSeq
  );
  return sessions[0];
}

function dispatchBuyerMessageHandlers(bridge, parsed) {
  const messages = extractBuyerMessagesFromWsPayload(parsed, bridge.shopTitle);
  if (!messages.length || !bridge.buyerMessageHandlers?.size) return;

  for (const fn of [...bridge.buyerMessageHandlers]) {
    try {
      fn(messages, parsed);
    } catch (err) {
      println(`[千帆] 买家消息回调异常：${err.message || err}`);
    }
  }
}

function dispatchFrameListeners(bridge, payload, direction, requestId) {
  const parsed = parseMaybeJson(payload);
  if (!parsed) return;

  bridge.lastWsFrameAt = Date.now();
  noteWsFrame(bridge, requestId, parsed, direction);
  dispatchBuyerMessageHandlers(bridge, parsed);

  for (const fn of [...bridge.frameListeners]) {
    try {
      fn(parsed, direction, requestId);
    } catch {
      // ignore
    }
  }
}

function noteBuyerAppCidOnBridge(shopTitle, appCid) {
  const bridge = findBridgeByShopTitle(shopTitle);
  const cid = String(appCid || '').trim();
  if (!bridge || !cid) return;

  for (const sess of bridge.wsSessions.values()) {
    sess.appCids.add(cid);
    sess.seenBuyerSync = true;
    sess.seenImpaasTraffic = true;
    sess.lastActivityAt = Date.now();
  }

  if (bridge.client?.Runtime) {
    void cdpRuntimeEvaluate(
      bridge.client.Runtime,
      {
        expression: `(function(){
        var cid = ${JSON.stringify(cid)};
        var list = window.__qfImpaasSockets || [];
        for (var i = 0; i < list.length; i++) {
          var ws = list[i];
          if (!ws || ws.readyState !== 1) continue;
          ws.__qfAppCids = ws.__qfAppCids || [];
          if (ws.__qfAppCids.indexOf(cid) < 0) ws.__qfAppCids.push(cid);
          ws.__qfSendRank = Math.max(ws.__qfSendRank || 0, 50);
        }
        return { ok: true, count: list.length };
      })()`,
        returnByValue: true,
      }
    ).catch(() => {});
  }
}

function matchesSendAck(parsed, ctx) {
  const hdr = parsed?.header || {};
  const body = parsed?.body || {};
  if (hdr.action !== '/message/send') return false;
  if (Number(hdr.type) !== 131) return false;
  if (body.code == null && body.msg == null) return false;

  if (ctx.traceId && hdr.traceId && hdr.traceId === ctx.traceId) return true;
  if (ctx.sMid && hdr.sMid && hdr.sMid === ctx.sMid) return true;
  const dataUuid = body.data?.uuid || body.uuid;
  if (ctx.uuid && dataUuid && dataUuid === ctx.uuid) return true;
  return false;
}

function waitForSendAck(bridge, ctx, timeoutMs = ACK_TIMEOUT_MS) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bridge.frameListeners.delete(onFrame);
      reject(new Error('千帆 ACK 超时'));
    }, timeoutMs);

    function onFrame(parsed) {
      if (Date.now() - startedAt < 50) return;
      if (!matchesSendAck(parsed, ctx)) return;

      const body = parsed?.body || {};
      if (body.code === 0 && body.msg === 'success' && body.data?.msgId) {
        clearTimeout(timer);
        bridge.frameListeners.delete(onFrame);
        resolve({
          msgId: String(body.data.msgId),
          createAt: body.data.createAt,
          traceId: ctx.traceId,
          sMid: ctx.sMid,
          uuid: ctx.uuid,
        });
        return;
      }

      if (body.code != null && body.code !== 0) {
        clearTimeout(timer);
        bridge.frameListeners.delete(onFrame);
        reject(new Error(body.msg || `ACK code ${body.code}`));
      }
    }

    bridge.frameListeners.add(onFrame);
  });
}

function waitForEchoVerify(bridge, shopTitle, { appCid, msgId, text, sentAfterMs }, timeoutMs = ECHO_VERIFY_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      bridge.frameListeners.delete(onFrame);
      resolve({ verified: false, reason: 'echo_timeout', msgId, appCid, text });
    }, timeoutMs);

    function onFrame(parsed) {
      const hdr = parsed?.header || {};
      if (hdr.action !== '/sync/unreliable') return;

      const messages = parseWsSessionMessages(parsed, shopTitle);
      for (const msg of messages) {
        if (msg.appCid !== appCid) continue;
        const createAt = Number(msg.createAt || 0);
        if (sentAfterMs && createAt && createAt < sentAfterMs - 2000) continue;

        if (msgId && msg.msgId === msgId) {
          clearTimeout(timer);
          bridge.frameListeners.delete(onFrame);
          resolve({ verified: true, reason: 'msgId_match', msgId: msg.msgId });
          return;
        }

        if (
          text &&
          String(msg.text || '').trim() === String(text).trim() &&
          msg.isSellerSide
        ) {
          clearTimeout(timer);
          bridge.frameListeners.delete(onFrame);
          resolve({ verified: true, reason: 'text_seller_match', msgId: msg.msgId });
          return;
        }
      }

      const raw = JSON.stringify(parsed);
      if (msgId && raw.includes(msgId) && raw.includes(appCid)) {
        const sellerHint = /SELLER|CSA|CUSTOMER_SERVICE|STAFF|ROBOT|"type":"BOT"/i.test(raw);
        if (sellerHint || raw.includes(String(text || ''))) {
          clearTimeout(timer);
          bridge.frameListeners.delete(onFrame);
          resolve({ verified: true, reason: 'raw_seller_match' });
        }
      }
    }

    bridge.frameListeners.add(onFrame);
  });
}

async function verifyViaHttpMessageList(bridge, { appCid, msgId, text, sentAfterMs }) {
  const fetched = await fetchMessageListForAppCid(bridge, appCid);
  if (!fetched?.ok || !fetched.body) return { verified: false, reason: fetched?.reason || 'http_fetch_fail' };

  const messages = extractMessagesFromResponse(fetched.body, bridge.shopTitle, 'http_verify');
  for (const msg of messages) {
    if (msg.appCid !== appCid) continue;
    const createAt = Number(msg.createAt || 0);
    if (sentAfterMs && createAt && createAt < sentAfterMs - 2000) continue;
    if (msgId && msg.msgId === msgId) {
      return { verified: true, reason: 'http_msgId_match', msgId: msg.msgId };
    }
    if (text && String(msg.text || '').trim() === String(text).trim() && msg.isSellerSide !== false) {
      const sender = String(msg.senderType || '').toUpperCase();
      if (sender && sender !== 'CUSTOMER') {
        return { verified: true, reason: 'http_text_match', msgId: msg.msgId };
      }
    }
  }

  return { verified: false, reason: 'http_not_found' };
}

function patchMessageListBody(bodyTemplate, appCid) {
  const cid = String(appCid || '').trim();
  if (!bodyTemplate) return JSON.stringify({ appCid: cid, limit: 20 });
  try {
    const obj = JSON.parse(bodyTemplate);
    if (Object.prototype.hasOwnProperty.call(obj, 'appCid')) obj.appCid = cid;
    if (Object.prototype.hasOwnProperty.call(obj, 'cid')) obj.cid = cid;
    if (obj.data && typeof obj.data === 'object' && Object.prototype.hasOwnProperty.call(obj.data, 'appCid')) {
      obj.data.appCid = cid;
    }
    if (obj.limit == null && obj.pageSize == null) obj.limit = 20;
    return JSON.stringify(obj);
  } catch {
    if (String(bodyTemplate).includes('appCid')) {
      return String(bodyTemplate).replace(/"appCid"\s*:\s*"[^"]*"/, `"appCid":"${cid}"`);
    }
    return bodyTemplate;
  }
}

async function fetchMessageListForAppCid(bridge, appCid) {
  const tpl = bridge.lastMessageListRequest;
  if (!tpl?.url || !tpl?.headers) return { ok: false, reason: 'http_template_missing' };

  const body = patchMessageListBody(tpl.bodyTemplate, appCid);
  const { Runtime } = bridge.client;
  try {
    const result = await cdpRuntimeEvaluate(Runtime, {
      expression: `(async function(){
        try {
          const res = await fetch(${JSON.stringify(tpl.url)}, {
            method: ${JSON.stringify(tpl.method || 'POST')},
            headers: ${JSON.stringify(tpl.headers)},
            body: ${JSON.stringify(body)},
            credentials: 'include',
          });
          const json = await res.json();
          return { ok: res.ok, status: res.status, body: json };
        } catch (e) {
          return { ok: false, error: String(e.message || e) };
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });

    const value = result?.result?.value;
    if (!value?.ok || !value.body) {
      return { ok: false, reason: value?.error || 'http_fetch_fail', status: value?.status };
    }
    return { ok: true, body: value.body, status: value.status };
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  }
}

function hasShopImpaasWs(bridge) {
  if ([...bridge.wsSessions.values()].some((s) => isImpaasWsSession(s, bridge))) return true;
  return [...bridge.wsUrls.values()].some((u) => {
    const url = String(u || '').toLowerCase();
    return url.includes('longlink') || url.includes('impaas') || url.includes('walle');
  });
}

async function probePageImpaasWs(bridge) {
  if (!isBridgeCdpReady(bridge)) return false;
  try {
    const result = await cdpRuntimeEvaluate(bridge.client.Runtime, {
      expression: `(function(){
        var list = window.__qfImpaasSockets || [];
        var open = list.filter(function(w){ return w && w.readyState === 1; });
        return { ok: open.length > 0, count: open.length };
      })()`,
      returnByValue: true,
    });
    return Boolean(result?.result?.value?.ok);
  } catch {
    return false;
  }
}

async function refreshBridgeNetwork(client) {
  try {
    const { Network } = client;
    if (!Network) return false;
    await cdpNetworkDisable(Network);
    await cdpNetworkEnable(Network);
    return true;
  } catch {
    return false;
  }
}

function registerShopReconnectWake(shopTitle, fn) {
  const key = normalizeShopKey(shopTitle);
  if (!key || typeof fn !== 'function') return;
  shopWakeReconnect.set(key, fn);
}

function unregisterShopReconnectWake(shopTitle) {
  shopWakeReconnect.delete(normalizeShopKey(shopTitle));
}

async function triggerShopReconnect(shopTitle, reason = 'send_no_ws') {
  const fn = shopWakeReconnect.get(normalizeShopKey(shopTitle));
  if (!fn) return false;
  try {
    fn(reason);
    return true;
  } catch {
    return false;
  }
}

async function ensureImpaasWsReady(bridge, appCid) {
  if (!bridge) return false;
  if (hasShopImpaasWs(bridge) || (await probePageImpaasWs(bridge))) return true;

  const shopLabel = normalizeShopKey(bridge.shopTitle);
  println(`[千帆发送] ${shopLabel} 未检测到 impaas WS，尝试唤醒...`);

  if (isBridgeCdpReady(bridge)) {
    await installWsHook(bridge.client);
    await refreshBridgeNetwork(bridge.client);
  }
  if (appCid) {
    noteBuyerAppCidOnBridge(bridge.shopTitle, appCid);
    if (bridge.lastMessageListRequest) {
      await fetchMessageListForAppCid(bridge, appCid);
    }
  }

  await new Promise((r) => setTimeout(r, IMPAAS_WAKE_WAIT_MS));
  if (hasShopImpaasWs(bridge) || (await probePageImpaasWs(bridge))) return true;

  const reconnected = await triggerShopReconnect(bridge.shopTitle, 'send_no_ws');
  if (reconnected) {
    println(`[千帆发送] ${shopLabel} 已请求 CDP 重连，等待 impaas WS...`);
    await new Promise((r) => setTimeout(r, IMPAAS_RECONNECT_WAIT_MS));
    const refreshed = findBridgeByShopTitle(bridge.shopTitle) || bridge;
    if (isBridgeCdpReady(refreshed)) {
      await installWsHook(refreshed.client);
    }
    return hasShopImpaasWs(refreshed) || (await probePageImpaasWs(refreshed));
  }

  return false;
}

function buildSendPayload({ appCid, receiverAppUids, text, seq, manualTemplate }) {
  const traceId = makeTraceId();
  const sMid = makeSMid();
  const uuid = makeUuid();

  let payload;
  if (manualTemplate?.payload) {
    payload = JSON.parse(JSON.stringify(manualTemplate.payload));
    payload.header = payload.header || {};
    payload.body = payload.body || {};
    payload.header.sTime = Date.now();
    payload.header.seq = seq;
    payload.header.type = 3;
    payload.header.bizId = payload.header.bizId || 10;
    payload.header.contentType = 'json';
    payload.header.traceId = traceId;
    payload.header.action = '/message/send';
    payload.header.serviceId = 'impaas.oi';
    payload.header.oneWay = false;
    payload.header.sMid = sMid;
    payload.body.appCid = appCid;
    payload.body.convType = payload.body.convType || 1;
    payload.body.uuid = uuid;
    payload.body.receiverAppUids = receiverAppUids;
    const ci = manualTemplate.payload?.body?.contentInfo || { contentType: 1 };
    payload.body.contentInfo = {
      ...ci,
      contentType: ci.contentType || 1,
      content: text,
    };
    if (payload.body.extension?.additionInfo) {
      try {
        const info = JSON.parse(payload.body.extension.additionInfo);
        info.uuid = crypto.randomUUID();
        payload.body.extension.additionInfo = JSON.stringify(info);
      } catch {
        payload.body.extension.additionInfo = JSON.stringify({
          uuid: crypto.randomUUID(),
          sendMsgDoubleCheck: false,
        });
      }
    }
  } else {
    payload = {
      header: {
        sTime: Date.now(),
        seq,
        type: 3,
        bizId: 10,
        contentType: 'json',
        traceId,
        action: '/message/send',
        serviceId: 'impaas.oi',
        oneWay: false,
        sMid,
      },
      body: {
        appCid,
        convType: 1,
        uuid,
        receiverAppUids,
        contentInfo: { contentType: 1, content: text },
        convCreateIsSelfVisible: true,
        convRedPointIsNotSelfClear: true,
        extension: {
          additionInfo: JSON.stringify({
            uuid: crypto.randomUUID(),
            sendMsgDoubleCheck: false,
          }),
        },
        callbackCtx: {},
      },
    };
  }

  return {
    payload,
    payloadStr: JSON.stringify(payload),
    sMid,
    seq,
    traceId,
    uuid,
    serviceId: 'impaas.oi',
    action: '/message/send',
  };
}

async function installWsHook(client) {
  const { Runtime, Page } = client;
  try {
    await cdpAddScriptToEvaluateOnNewDocument(Page, WS_HOOK_SCRIPT);
  } catch {
    // ignore
  }
  await cdpRuntimeEvaluate(Runtime, { expression: WS_HOOK_SCRIPT, returnByValue: true }).catch(() => {});
}

async function sendViaPageRuntime(client, payloadStr, appCid) {
  const { Runtime } = client;
  for (let i = 0; i < 6; i++) {
    try {
      const result = await cdpRuntimeEvaluate(Runtime, {
      expression: `(function(){
        var appCid = ${JSON.stringify(appCid || '')};
        var pick = window.__qfPickSendSocket && window.__qfPickSendSocket(appCid);
        var list = window.__qfImpaasSockets || [];
        var ws = null;
        if (pick && pick.ok) {
          ws = list.find(function(w){ return w && w.readyState === 1 && String(w.url||'') === pick.url; });
        }
        if (!ws) ws = list.find(function(w){ return w && w.readyState === 1 && (w.__qfSendRank || 0) >= 100; });
        if (!ws) ws = list.find(function(w){ return w && w.readyState === 1; });
        if (!ws) return { ok: false, reason: 'no_ws', count: list.length };
        ws.send(${JSON.stringify(payloadStr)});
        return { ok: true, url: String(ws.url || ''), rank: ws.__qfSendRank || 0, count: list.length };
      })()`,
      returnByValue: true,
    });
    const value = result?.result?.value;
    if (value?.ok) return value;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, reason: 'no_ws' };
}

function findBridgeByShopTitle(shopTitle) {
  const key = normalizeShopKey(shopTitle);
  for (const [registered, bridge] of bridges) {
    if (normalizeShopKey(registered) === key) return bridge;
  }
  return null;
}

function registerBuyerMessageHandler(shopTitle, handler) {
  const bridge = findBridgeByShopTitle(shopTitle);
  if (!bridge || typeof handler !== 'function') return false;
  if (!bridge.buyerMessageHandlers.has(handler)) {
    bridge.buyerMessageHandlers.add(handler);
  }
  return true;
}

function getBridgeWsActivity(shopTitle) {
  const bridge = findBridgeByShopTitle(shopTitle);
  if (!bridge) return { lastWsFrameAt: 0, sessions: 0, connectedAt: 0 };
  let lastActivityAt = bridge.lastWsFrameAt || 0;
  for (const sess of bridge.wsSessions.values()) {
    if (sess.lastActivityAt > lastActivityAt) lastActivityAt = sess.lastActivityAt;
  }
  return {
    lastWsFrameAt: bridge.lastWsFrameAt || 0,
    lastActivityAt,
    connectedAt: bridge.connectedAt || 0,
    sessions: bridge.wsSessions.size,
  };
}

function isBridgeCdpReady(bridge) {
  return Boolean(bridge?.cdpReady && bridge?.client?.Runtime);
}

function markBridgeCdpClosed(shopTitle) {
  const bridge = findBridgeByShopTitle(shopTitle);
  if (!bridge) return;
  bridge.cdpReady = false;
  bridge.client = null;
}

function isCdpTransportError(err) {
  const msg = String(err?.message || err || '');
  return /WebSocket is not open|readyState\s*3|CLOSED|disconnected|Target closed/i.test(msg);
}

async function fetchHttpTemplate(bridge, tpl) {
  if (!tpl?.url || !isBridgeCdpReady(bridge)) {
    return { ok: false, reason: 'cdp_not_ready' };
  }

  const { Runtime } = bridge.client;
  try {
    const result = await cdpRuntimeEvaluate(Runtime, {
      expression: `(async function(){
        try {
          const res = await fetch(${JSON.stringify(tpl.url)}, {
            method: ${JSON.stringify(tpl.method || 'POST')},
            headers: ${JSON.stringify(tpl.headers || {})},
            body: ${JSON.stringify(tpl.bodyTemplate || '')},
            credentials: 'include',
          });
          const json = await res.json();
          return { ok: res.ok, status: res.status, body: json };
        } catch (e) {
          return { ok: false, error: String(e.message || e) };
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });

    const value = result?.result?.value;
    if (!value?.ok || !value.body) {
      return { ok: false, reason: value?.error || 'http_fetch_fail', status: value?.status };
    }
    return { ok: true, body: value.body, status: value.status, pathKey: tpl.pathKey };
  } catch (err) {
    if (isCdpTransportError(err)) {
      bridge.cdpReady = false;
      bridge.client = null;
    }
    return { ok: false, reason: String(err.message || err) };
  }
}

async function registerQianfanWsBridge(pageInfo, client) {
  const shopTitle = pageInfo.shopTitle || pageInfo.pageTitle || '';
  if (!shopTitle) return null;

  await installWsHook(client);
  await installUiSyncBridge(client);

  const prev = findBridgeByShopTitle(shopTitle);
  const bridge = {
    shopTitle,
    pageInfo,
    client,
    cdpReady: true,
    connectedAt: Date.now(),
    lastSeq: prev?.lastSeq || 0,
    lastWsFrameAt: 0,
    frameListeners: prev?.frameListeners || new Set(),
    buyerMessageHandlers: prev?.buyerMessageHandlers || new Set(),
    httpTemplates: prev?.httpTemplates || new Map(),
    wsSessions: new Map(),
    wsUrls: new Map(),
    lastManualSendByAppCid: prev?.lastManualSendByAppCid || new Map(),
    lastManualSendAny: prev?.lastManualSendAny || null,
    lastMessageListRequest: prev?.lastMessageListRequest || null,
  };

  const { Network } = client;
  Network.webSocketCreated(({ requestId, url }) => {
    bridge.wsUrls.set(requestId, String(url || ''));
    bridge.wsSessions.set(requestId, {
      requestId,
      url: String(url || ''),
      seenMessageSend: false,
      seenReadFromOne: false,
      seenBuyerSync: false,
      seenImpaasTraffic: false,
      appCids: new Set(),
      lastSeq: 0,
      lastManualSendAt: 0,
      lastActivityAt: 0,
    });
  });

  Network.requestWillBeSent(({ request }) => {
    captureHttpTemplate(bridge, request);
  });

  Network.webSocketFrameReceived((params) => {
    const payload = params.response?.payloadData;
    if (!payload || payload === 'ping' || payload === 'pong') return;
    dispatchFrameListeners(bridge, payload, 'received', params.requestId);
  });

  Network.webSocketFrameSent((params) => {
    const payload = params.response?.payloadData;
    if (!payload) return;
    dispatchFrameListeners(bridge, payload, 'sent', params.requestId);
  });

  bridges.set(shopTitle, bridge);
  bridges.set(normalizeShopKey(shopTitle), bridge);
  return bridge;
}

async function sendQianfanTextReply({ shopTitle, appCid, receiverAppUids, text, buyerNick = '' }) {
  let bridge = findBridgeByShopTitle(shopTitle);
  if (!bridge) {
    throw new Error(`未找到店铺「${normalizeShopKey(shopTitle)}」的千帆发送桥，请确认该店铺工作台已打开`);
  }

  const shopLabel = normalizeShopKey(shopTitle);
  const impaasReady = await ensureImpaasWsReady(bridge, appCid);
  bridge = findBridgeByShopTitle(shopTitle) || bridge;
  if (!impaasReady) {
    throw new Error(
      `未找到店铺「${shopLabel}」可用的千帆 impaas WebSocket，请确认该店铺工作台已打开并处于活跃会话`
    );
  }
  if (!isBridgeCdpReady(bridge)) {
    throw new Error(`店铺「${shopLabel}」CDP 连接不可用，请确认千帆工作台页面未关闭`);
  }

  const sessionContext = getSessionContext(shopTitle, appCid);
  let finalReceiverAppUids = [...(receiverAppUids || [])].filter(Boolean);
  if (!finalReceiverAppUids.length && sessionContext?.receiverAppUids?.length) {
    finalReceiverAppUids = [...sessionContext.receiverAppUids];
  }

  const manualForCid = bridge.lastManualSendByAppCid.get(appCid) || null;
  const manualTemplate = manualForCid || bridge.lastManualSendAny || null;
  if (!finalReceiverAppUids.length && manualForCid?.receiverAppUids?.length) {
    finalReceiverAppUids = manualForCid.receiverAppUids;
  }

  if (!finalReceiverAppUids.length) {
    throw new Error('缺少 receiverAppUids，无法向买家发送');
  }

  const sendSession = pickSendSession(bridge, appCid);
  const seq = Math.max(bridge.lastSeq, sendSession?.lastSeq || 0) + 1;

  println(`[千帆发送] 使用店铺桥：${shopLabel}`);
  println(`[千帆发送] 使用会话上下文 receiverAppUids=${JSON.stringify(finalReceiverAppUids)}`);
  println(
    `[千帆发送] 准备发送：店铺=${shopLabel} 买家=${buyerNick || sessionContext?.buyerNick || '买家'} appCid=${appCid} content=${text}`
  );
  if (sendSession) {
    println(
      `[千帆发送] WS会话 requestId=${sendSession.requestId} url=${sendSession.url || bridge.wsUrls.get(sendSession.requestId) || 'unknown'} seenSend=${sendSession.seenMessageSend} seenBuyer=${sendSession.seenBuyerSync}`
    );
  }

  const built = buildTextSendPayloadFromContext({
    shopTitle: shopLabel,
    appCid,
    receiverAppUids: finalReceiverAppUids,
    text,
    seq,
    sessionContext,
    manualTemplate,
  });

  if (manualTemplate?.bodySummary) {
    printPayloadDiff(manualTemplate.bodySummary, summarizeBody(built.payload.body));
  } else if (!manualTemplate) {
    println('[千帆发送] 无手动样本，使用默认 payload 结构');
  }

  const ctx = {
    traceId: built.traceId,
    sMid: built.sMid,
    uuid: built.uuid,
    seq: built.seq,
    appCid,
    text,
  };

  writeSendDebug({
    event: 'prepare_send',
    shopTitle: shopLabel,
    appCid,
    receiverAppUids: finalReceiverAppUids,
    text,
    traceId: ctx.traceId,
    sMid: ctx.sMid,
    uuid: ctx.uuid,
    seq: ctx.seq,
    sendSessionRequestId: sendSession?.requestId || null,
    payload: built.payload,
  });

  writeBotSendSample({
    shopTitle: shopLabel,
    appCid,
    receiverAppUids: finalReceiverAppUids,
    text,
    payload: built.payload,
    bodySummary: summarizeBody(built.payload.body),
    manualTemplateUsed: Boolean(manualTemplate),
  });

  const sentAtMs = Date.now();
  const ackPromise = waitForSendAck(bridge, ctx, ACK_TIMEOUT_MS);

  const sent = await sendViaPageRuntime(bridge.client, built.payloadStr, appCid);
  if (!sent.ok) {
    writeSendDebug({ event: 'send_fail', reason: sent.reason || 'no_ws', ...ctx });
    throw new Error(`未找到店铺「${shopLabel}」可用的千帆 impaas WebSocket，请确认该店铺工作台已打开`);
  }

  writeSendDebug({ event: 'ws_send_called', wsUrl: sent.url, wsRank: sent.rank, wsCount: sent.count, ...ctx });

  let ack;
  try {
    ack = await ackPromise;
  } catch (err) {
    writeSendDebug({ event: 'ack_fail', error: String(err.message || err), ...ctx });
    throw err;
  }

  writeSendDebug({ event: 'ack_ok', qianfanMsgId: ack.msgId, createAt: ack.createAt, ...ctx });
  println(`[千帆] ACK 成功，msgId=${ack.msgId} traceId=${ctx.traceId}`);

  const pcSync = await (async () => {
    try {
      return await withTimeout(
        syncQianfanConversationUi({
          shopTitle: bridge.shopTitle,
          appCid,
          buyerNick,
          qianfanMsgId: ack.msgId,
          text,
          sentAt: sentAtMs,
          page: bridge.pageInfo,
          cdpSession: bridge.client,
          messageListTpl: bridge.lastMessageListRequest,
        }),
        UI_SYNC_TIMEOUT_MS,
        'syncQianfanConversationUi'
      );
    } catch (err) {
      println(`[千帆] PC 同步超时/失败（不影响 ACK）：${err.message || err}`);
      return { ok: false, apiConfirmed: false, reselected: false, localEcho: false };
    }
  })();

  let echo = await waitForEchoVerify(bridge, bridge.shopTitle, {
    appCid,
    msgId: ack.msgId,
    text,
    sentAfterMs: sentAtMs,
  });

  if (!echo.verified) {
    const httpEcho = await verifyViaHttpMessageList(bridge, {
      appCid,
      msgId: ack.msgId,
      text,
      sentAfterMs: sentAtMs,
    });
    if (httpEcho.verified) echo = httpEcho;
  }

  if (echo.verified) {
    println(`[千帆] 回显验证：成功 msgId=${echo.msgId || ack.msgId}（${echo.reason}）`);
    writeSendDebug({ event: 'echo_ok', echoReason: echo.reason, qianfanMsgId: ack.msgId, ...ctx });
  } else {
    println('[千帆] 回显验证：未捕获（PC 客服台可能未刷新，不影响 ACK 成功判定）');
    writeSendDebug({ event: 'echo_optional_miss', echoReason: echo.reason, qianfanMsgId: ack.msgId, ...ctx });
  }

  bridge.lastSeq = seq;
  if (sendSession) sendSession.lastSeq = seq;

  return {
    ...ack,
    ackConfirmed: true,
    echoVerified: echo.verified,
    echoReason: echo.reason,
    pcSyncOk: pcSync.ok,
    traceId: ctx.traceId,
    sMid: ctx.sMid,
    uuid: ctx.uuid,
  };
}

function getBridgeActiveAppCids(bridge) {
  const set = new Set();
  if (!bridge) return [];
  for (const sess of bridge.wsSessions?.values() || []) {
    for (const cid of sess.appCids || []) {
      const s = String(cid || '').trim();
      if (s) set.add(s);
    }
  }
  return [...set];
}

function listRegisteredShops() {
  return [...bridges.keys()];
}

module.exports = {
  registerQianfanWsBridge,
  registerBuyerMessageHandler,
  registerShopReconnectWake,
  unregisterShopReconnectWake,
  getBridgeWsActivity,
  fetchHttpTemplate,
  fetchMessageListForAppCid,
  getBridgeActiveAppCids,
  isBridgeCdpReady,
  markBridgeCdpClosed,
  sendQianfanTextReply,
  findBridgeByShopTitle,
  noteBuyerAppCidOnBridge,
  listRegisteredShops,
  normalizeShopKey,
  HTTP_CAPTURE_PATHS,
};
