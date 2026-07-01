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
const {
  buildTextSendPayloadFromContext,
  isUsableTextManualTemplate,
  isValidAppCid,
} = require('./qf-send-payload');
const { getSessionContext, getReceiverAppUids, findReceiverCacheForShop, buyerNickMatches, rememberReceiverAppUids, saveSessionContext, extractReceiverAppUidsFromMessage } = require('./qianfan-data-store');
const { installUiSyncBridge, sendBuyerTextViaUi } = require('./qianfan-ui-sync');
const { assertSendAllowedForBuyer } = require('./qianfan-send-guard');
const { triggerNativeSyncAfterAck, installNativeSyncBridge } = require('./qianfan-native-sync');
const { println } = require('./utils');
const { cdpRuntimeEvaluate, withTimeout, cdpAddScriptToEvaluateOnNewDocument, cdpNetworkEnable, cdpNetworkDisable, cdpNetworkSendWebSocketFrame } = require('./cdp-timeout');
const { logBotSendLifecycle, summarizePayload } = require('./capture/bot-send-debug');

const bridges = new Map();
const shopWakeReconnect = new Map();
const shopProbeCooldown = new Map();
const IMPAAS_WAKE_WAIT_MS = 1200;
const IMPAAS_RECONNECT_WAIT_MS = 4500;
const IMPAAS_SEND_RETRY_ROUNDS = 2;
const IMPAAS_QUICK_WAKE_ROUNDS = 1;
const IMPAAS_SESSION_FRESH_MS = 120000;
const MANUAL_SEND_FRESH_MS = 300000;
const WS_WAKE_CAPTURE_WAIT_MS = 8000;
const PROBE_COOLDOWN_MS = 60000;
const WS_SEND_READY_POLL_MS = 300;
const WS_SEND_READY_POLL_ROUNDS = 10;
const BRIDGE_YOUNG_MS = 15000;
const PROBE_MIN_BRIDGE_AGE_MS = 30000;
const SEND_PAYLOAD_BUDGET_MS = 28000;
const ACK_TIMEOUT_MS = 8000;
const ECHO_VERIFY_MS = 10000;
const UI_SYNC_TIMEOUT_MS = 12000;
const WS_PROTOCOL_EXCLUDE_RE = /hot-update|vite|sockjs|hmr|analytics|track|log|sentry/i;
const MAX_RECENT_WS_HEARTBEAT_FRAMES = 40;

const WS_HOOK_SCRIPT = `(function(){
  window.__qfImpaasSockets = (window.__qfImpaasSockets || []).filter(function(w){ return w && w.readyState === 1; });
  function noteAckFrame(raw) {
    try {
      var s = String(raw || '');
      if (s.indexOf('/message/send') < 0) return;
      window.__qfAckEvents = window.__qfAckEvents || [];
      window.__qfAckEvents.push({ t: Date.now(), raw: s });
      if (window.__qfAckEvents.length > 80) window.__qfAckEvents.shift();
    } catch (e) {}
  }
  function hookWsMessage(ws) {
    if (!ws || ws.__qfAckMsgHooked) return;
    ws.__qfAckMsgHooked = true;
    ws.addEventListener('message', function(ev) {
      noteAckFrame(ev.data);
    });
  }
  function track(ws) {
    try {
      if (!ws || ws.readyState !== 1) return;
      const u = String(ws.url || '');
      if (u.includes('longlink') || u.includes('impaas') || u.includes('walle') || u.includes('xiaohongshu') || u.includes('edith')) {
        if (!window.__qfImpaasSockets.includes(ws)) window.__qfImpaasSockets.push(ws);
        if (u.includes('longlink')) ws.__qfSendRank = Math.max(ws.__qfSendRank || 0, 10);
        hookWsMessage(ws);
      }
    } catch (e) {}
  }
  window.__qfScanSendAck = function(ctx, sentAfterMs) {
    var events = window.__qfAckEvents || [];
    for (var i = events.length - 1; i >= 0; i--) {
      var ev = events[i];
      if (sentAfterMs && ev.t < sentAfterMs - 200) continue;
      try {
        var parsed = JSON.parse(ev.raw);
        var hdr = parsed.header || {};
        var body = parsed.body || {};
        if (hdr.action !== '/message/send') continue;
        if (Number(hdr.type) === 3) continue;
        if (body.code == null && body.msg == null && !body.data) continue;
        var match = (ctx.traceId && hdr.traceId === ctx.traceId)
          || (ctx.sMid && hdr.sMid === ctx.sMid)
          || (ctx.uuid && (body.data && body.data.uuid || body.uuid) === ctx.uuid);
        if (!match) continue;
        if (body.code === 0 && body.data && body.data.msgId) {
          return { ok: true, msgId: String(body.data.msgId), createAt: body.data.createAt, ackParsed: parsed, ackData: body.data || {} };
        }
        if (body.code != null && body.code !== 0) {
          return { ok: false, error: body.msg || ('ACK code ' + body.code) };
        }
      } catch (e) {}
    }
    return null;
  };
  window.__qfRehookImpaasSockets = function() {
    var list = window.__qfImpaasSockets || [];
    for (var i = 0; i < list.length; i++) track(list[i]);
    return list.length;
  };
  if (window.__qfBridgeHooked) {
    return { ok: true, already: true, count: window.__qfRehookImpaasSockets() };
  }
  window.__qfBridgeHooked = true;
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
  return { ok: true, count: window.__qfRehookImpaasSockets() };
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
  if (entry?.event && /prepare_send|ws_send_called|ack_ok|ack_fail|echo_ok|echo_optional_miss|send_fail/.test(entry.event)) {
    logBotSendLifecycle(entry.event, {
      ...entry,
      shopTitle: entry.shopTitle || entry.shopId,
      gotAck: entry.event === 'ack_ok' || entry.gotAck === true,
      gotMessagePush: entry.event === 'echo_ok' || entry.gotMessagePush === true,
      gotConversationUpdate: entry.gotConversationUpdate,
      bubbleInserted: entry.bubbleInserted,
      countdownCleared: entry.countdownCleared,
      payloadSummary: entry.payload ? summarizePayload(entry.payload) : entry.payloadSummary,
    });
  }
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
    capturedAt: Date.now(),
  };

  bridge.lastManualSendByAppCid.set(appCid, sample);
  bridge.lastManualSendAny = sample;
  writeManualSendSample(sample);
  println(
    `[千帆] 已捕获手动发送 WS：店铺=${sample.shopTitle} appCid=${appCid} requestId=${requestId}`
  );
}

function captureManualImageSend(bridge, parsed, requestId) {
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
    capturedAt: Date.now(),
  };

  bridge.lastManualImageSendByAppCid.set(appCid, sample);
  bridge.lastManualImageSendAny = sample;
  writeManualSendSample({ ...sample, kind: 'image' });
  println(
    `[千帆] 已捕获手动图片发送 WS：店铺=${sample.shopTitle} appCid=${appCid} requestId=${requestId}`
  );
}

function isRelevantProtocolWsUrl(url) {
  const u = String(url || '');
  if (!u || WS_PROTOCOL_EXCLUDE_RE.test(u)) return false;
  return /longlink|impaas|walle|xiaohongshu|edith|qianfan/i.test(u);
}

function noteWsHeartbeatFrame(bridge, payload, direction, requestId) {
  if (!bridge) return;
  const raw = String(payload || '').trim();
  if (!raw) return;
  const lower = raw.toLowerCase();
  if (!/(^|\b)(ping|pong|heartbeat|keepalive)(|\b)/i.test(lower) && raw.length > 64) return;
  if (!Array.isArray(bridge.recentWsHeartbeatFrames)) bridge.recentWsHeartbeatFrames = [];
  bridge.recentWsHeartbeatFrames.push({
    at: Date.now(),
    direction,
    requestId,
    preview: raw.slice(0, 200),
  });
  if (bridge.recentWsHeartbeatFrames.length > MAX_RECENT_WS_HEARTBEAT_FRAMES) {
    bridge.recentWsHeartbeatFrames.shift();
  }
}

function getRecentManualSendSample(bridge, appCid) {
  if (!bridge) return null;
  const cid = String(appCid || '').trim();
  const candidates = [];
  if (cid) {
    const exact = bridge.lastManualSendByAppCid.get(cid);
    if (exact) candidates.push(exact);
  }
  if (bridge.lastManualSendAny) candidates.push(bridge.lastManualSendAny);

  const now = Date.now();
  for (const sample of candidates) {
    if (!sample?.requestId) continue;
    const sess = bridge.wsSessions.get(sample.requestId);
    const capturedAt = Number(sample.capturedAt || sess?.lastManualSendAt || sess?.lastActivityAt || 0);
    if (capturedAt && now - capturedAt <= MANUAL_SEND_FRESH_MS) {
      return { ...sample, capturedAt, session: sess || null };
    }
  }
  return null;
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
    const contentType = Number(body.contentInfo?.contentType);
    if (contentType === 1) captureManualSend(bridge, parsed, requestId);
    else captureManualImageSend(bridge, parsed, requestId);
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
  const ackType = Number(hdr.type);
  if (ackType === 3) return false;
  if (ackType !== 131 && ackType !== 130 && ackType !== 132) {
    if (body.code == null || !body.data?.msgId) return false;
  }
  if (body.code == null && body.msg == null && !body.data?.msgId) return false;

  if (ctx.traceId && hdr.traceId && hdr.traceId === ctx.traceId) return true;
  if (ctx.sMid && hdr.sMid && hdr.sMid === ctx.sMid) return true;
  const dataUuid = body.data?.uuid || body.uuid;
  if (ctx.uuid && dataUuid && dataUuid === ctx.uuid) return true;
  return false;
}

function parseSendAckFrame(parsed, ctx) {
  if (!matchesSendAck(parsed, ctx)) return null;

  const body = parsed?.body || {};
  if (body.code === 0 && body.data?.msgId) {
    return {
      msgId: String(body.data.msgId),
      createAt: body.data.createAt,
      ackParsed: parsed,
      ackData: body.data || {},
      traceId: ctx.traceId,
      sMid: ctx.sMid,
      uuid: ctx.uuid,
    };
  }

  if (body.code != null && body.code !== 0) {
    return { error: new Error(body.msg || `ACK code ${body.code}`) };
  }

  return null;
}

async function scanPageSendAck(bridge, ctx, sentAfterMs) {
  if (!isBridgeCdpReady(bridge)) return null;
  try {
    const result = await cdpRuntimeEvaluate(bridge.client.Runtime, {
      expression: `(function(){
        return window.__qfScanSendAck && window.__qfScanSendAck(
          ${JSON.stringify({ traceId: ctx.traceId, sMid: ctx.sMid, uuid: ctx.uuid })},
          ${Number(sentAfterMs) || 0}
        );
      })()`,
      returnByValue: true,
    });
    const value = result?.result?.value;
    if (!value) return null;
    if (value.ok && value.msgId) {
      return {
        msgId: String(value.msgId),
        createAt: value.createAt,
        ackParsed: value.ackParsed || null,
        ackData: value.ackData || {},
        traceId: ctx.traceId,
        sMid: ctx.sMid,
        uuid: ctx.uuid,
        ackSource: 'page',
      };
    }
    if (value.error) return { error: new Error(String(value.error)) };
  } catch {
    // ignore
  }
  return null;
}

async function waitForSendAck(bridge, ctx, sentAfterMs, timeoutMs = ACK_TIMEOUT_MS) {
  let cdpHit = null;
  let cdpError = null;

  function onFrame(parsed) {
    const frameTime = Number(parsed?.header?.sTime || 0);
    if (sentAfterMs && frameTime && frameTime < sentAfterMs - 500) return;

    const parsedAck = parseSendAckFrame(parsed, ctx);
    if (!parsedAck) return;
    if (parsedAck.error) {
      cdpError = parsedAck.error;
      return;
    }
    cdpHit = { ...parsedAck, ackSource: 'cdp' };
  }

  bridge.frameListeners.add(onFrame);
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      if (cdpHit) return cdpHit;
      if (cdpError) throw cdpError;

      const pageHit = await scanPageSendAck(bridge, ctx, sentAfterMs);
      if (pageHit?.msgId) return pageHit;
      if (pageHit?.error) throw pageHit.error;

      await new Promise((r) => setTimeout(r, 150));
    }

    const httpEcho = await verifyViaHttpMessageList(bridge, {
      appCid: ctx.appCid,
      msgId: null,
      text: ctx.text,
      sentAfterMs,
    });
    if (httpEcho.verified && httpEcho.msgId) {
      println(`[千帆] ACK 超时但 HTTP 已确认消息送达 msgId=${httpEcho.msgId}（${httpEcho.reason}）`);
      return {
        msgId: String(httpEcho.msgId),
        createAt: Date.now(),
        ackParsed: null,
        ackData: {},
        traceId: ctx.traceId,
        sMid: ctx.sMid,
        uuid: ctx.uuid,
        ackSource: 'http',
      };
    }

    throw new Error('千帆 ACK 超时');
  } finally {
    bridge.frameListeners.delete(onFrame);
  }
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
      if (sentAfterMs && (!createAt || createAt < sentAfterMs - 500)) continue;
      const sender = String(msg.senderType || '').toUpperCase();
      if (sender && sender !== 'CUSTOMER') {
        return { verified: true, reason: 'http_text_match', msgId: msg.msgId };
      }
    }
  }

  return { verified: false, reason: 'http_not_found' };
}

function extractChatIdFromBridge(bridge) {
  for (const tpl of bridge?.httpTemplates?.values() || []) {
    const raw = String(tpl?.bodyTemplate || tpl?.postData || '');
    const m = raw.match(/"chatIdList"\s*:\s*\[\s*"([^"]+)"/);
    if (m?.[1]) return m[1];
    const m2 = raw.match(/"chatId"\s*:\s*"([^"]+)"/);
    if (m2?.[1]) return m2[1];
  }
  return '';
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

async function fetchMessageListRaw(bridge) {
  const tpl = bridge.lastMessageListRequest;
  if (!tpl?.url || !tpl?.headers) return { ok: false, reason: 'http_template_missing' };
  if (!isBridgeCdpReady(bridge)) return { ok: false, reason: 'cdp_not_ready' };

  const body = tpl.bodyTemplate || '{}';
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

function pickBuyerMessageForNick(messages, buyerNick) {
  const nick = String(buyerNick || '').trim();
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return null;
  if (nick) {
    const matched = list.filter((msg) => buyerNickMatches(msg?.buyerNick, nick));
    if (matched.length) return matched[matched.length - 1];
  }
  const buyers = list.filter((msg) => String(msg?.senderType || '').toUpperCase() === 'CUSTOMER' || String(msg?.senderAppUid || '').includes('#2#2#'));
  return buyers.length ? buyers[buyers.length - 1] : list[list.length - 1];
}

function buildReplyContextFromMessage(shopTitle, message) {
  if (!message) return null;
  const shopKey = normalizeShopKey(shopTitle);
  const appCid = String(message.appCid || '').trim();
  const receiverAppUids = extractReceiverAppUidsFromMessage(message);
  if (!appCid || !receiverAppUids.length) return null;
  return {
    shopTitle: shopKey,
    appCid,
    buyerNick: String(message.buyerNick || '买家').trim(),
    receiverAppUids,
  };
}

async function fetchMessageListForAppCid(bridge, appCid) {
  const tpl = bridge.lastMessageListRequest;
  if (!tpl?.url || !tpl?.headers) return { ok: false, reason: 'http_template_missing' };
  if (!isBridgeCdpReady(bridge)) return { ok: false, reason: 'cdp_not_ready' };

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

function hasRecentImpaasSession(bridge) {
  if (!bridge) return false;
  const now = Date.now();
  if (bridge.lastWsFrameAt && now - bridge.lastWsFrameAt <= IMPAAS_SESSION_FRESH_MS) {
    return true;
  }
  for (const sess of bridge?.wsSessions?.values() || []) {
    if (!sess?.requestId) continue;
    if (sess.lastActivityAt && now - sess.lastActivityAt <= IMPAAS_SESSION_FRESH_MS) {
      return true;
    }
  }
  return false;
}

function listSendCandidateSessions(bridge, appCid) {
  const now = Date.now();
  const ranked = new Map();
  const add = (sess, freshOnly = false) => {
    const requestId = String(sess?.requestId || '').trim();
    if (!requestId || ranked.has(requestId)) return;
    const lastActivityAt = Number(sess?.lastActivityAt || 0);
    const fresh = lastActivityAt && now - lastActivityAt <= IMPAAS_SESSION_FRESH_MS;
    if (freshOnly && !fresh) return;
    ranked.set(requestId, {
      ...sess,
      requestId,
      url: sess.url || bridge.wsUrls.get(requestId) || '',
      lastActivityAt,
      _fresh: fresh,
    });
  };

  add(pickSendSession(bridge, appCid), false);
  for (const sess of bridge?.wsSessions?.values() || []) add(sess, true);
  for (const [requestId, url] of bridge?.wsUrls?.entries() || []) {
    add({
      requestId,
      url,
      appCids: new Set(),
      seenImpaasTraffic: false,
      seenBuyerSync: false,
      seenMessageSend: false,
      lastActivityAt: 0,
      lastSeq: 0,
    }, false);
  }

  return [...ranked.values()].sort(
    (a, b) =>
      Number(b._fresh) - Number(a._fresh) ||
      scoreSendSession(b, appCid) - scoreSendSession(a, appCid)
  );
}

async function prepareShopSendBridge(bridge, shopTitle, appCid) {
  const shopLabel = normalizeShopKey(shopTitle);
  if (!isBridgeCdpReady(bridge)) {
    bridge = (await waitForBridgeCdpReady(shopTitle, IMPAAS_RECONNECT_WAIT_MS)) || findBridgeByShopTitle(shopTitle) || bridge;
  }
  if (!isBridgeCdpReady(bridge)) {
    throw new Error(`店铺「${shopLabel}」CDP 连接不可用，请确认千帆工作台页面未关闭`);
  }
  const bridgeAgeMs = Date.now() - Number(bridge.connectedAt || 0);
  if (bridgeAgeMs < BRIDGE_YOUNG_MS && !(await probePageImpaasWs(bridge)).ok) {
    println(`[千帆发送] ${shopLabel} 新接入店铺，轮询 WS 就绪...`);
    await installWsHook(bridge.client);
    for (let i = 0; i < WS_SEND_READY_POLL_ROUNDS; i += 1) {
      if ((await probePageImpaasWs(bridge)).ok) break;
      await new Promise((r) => setTimeout(r, WS_SEND_READY_POLL_MS));
    }
  }
  noteBuyerAppCidOnBridge(shopTitle, appCid);
  return findBridgeByShopTitle(shopTitle) || bridge;
}

async function hasLiveImpaasWs(bridge) {
  if (!isBridgeCdpReady(bridge)) return false;
  return (await probePageImpaasWs(bridge)).ok;
}

function hasShopImpaasWs(bridge) {
  return hasRecentImpaasSession(bridge);
}

async function probePageImpaasWs(bridge) {
  if (!isBridgeCdpReady(bridge)) return { ok: false, count: 0 };
  try {
    const result = await cdpRuntimeEvaluate(bridge.client.Runtime, {
      expression: `(function(){
        if (window.__qfRehookImpaasSockets) window.__qfRehookImpaasSockets();
        var list = window.__qfImpaasSockets || [];
        var open = list.filter(function(w){ return w && w.readyState === 1; });
        return { ok: open.length > 0, count: open.length, total: list.length };
      })()`,
      returnByValue: true,
    });
    const value = result?.result?.value;
    return { ok: Boolean(value?.ok), count: Number(value?.count) || 0, total: Number(value?.total) || 0 };
  } catch {
    return { ok: false, count: 0, total: 0 };
  }
}

async function refreshBridgeNetwork(client) {
  if (!client?.Network) return false;
  try {
    const { Network } = client;
    await cdpNetworkDisable(Network);
    await cdpNetworkEnable(Network);
    return true;
  } catch {
    return false;
  }
}

async function waitForBridgeCdpReady(shopTitle, timeoutMs = IMPAAS_RECONNECT_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bridge = findBridgeByShopTitle(shopTitle);
    if (bridge && isBridgeCdpReady(bridge)) return bridge;
    await new Promise((r) => setTimeout(r, 300));
  }
  return findBridgeByShopTitle(shopTitle);
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

async function ensureImpaasWsReady(bridge, appCid, options = {}) {
  if (!bridge) return false;

  if ((await probePageImpaasWs(bridge)).ok) return true;

  const shopLabel = normalizeShopKey(bridge.shopTitle);
  const rounds =
    Number(options.rounds) > 0
      ? Number(options.rounds)
      : options.aggressive
        ? IMPAAS_SEND_RETRY_ROUNDS
        : IMPAAS_QUICK_WAKE_ROUNDS;

  for (let round = 0; round < rounds; round += 1) {
    if (await hasLiveImpaasWs(bridge)) return true;

    if (round === 0) {
      println(`[千帆发送] ${shopLabel} 未检测到可用 impaas WS，尝试唤醒...`);
    } else {
      println(`[千帆发送] ${shopLabel} 第 ${round + 1} 次唤醒 impaas WS...`);
    }

    if (isBridgeCdpReady(bridge)) {
      await installWsHook(bridge.client);
      await refreshBridgeNetwork(bridge.client);
    }
    if (appCid) {
      noteBuyerAppCidOnBridge(bridge.shopTitle, appCid);
      if (isBridgeCdpReady(bridge) && bridge.lastMessageListRequest) {
        await fetchMessageListForAppCid(bridge, appCid);
      }
    }

    await new Promise((r) => setTimeout(r, IMPAAS_WAKE_WAIT_MS));
    if (await hasLiveImpaasWs(bridge)) return true;

    const reconnected = await triggerShopReconnect(bridge.shopTitle, 'send_no_ws');
    if (reconnected) {
      println(`[千帆发送] ${shopLabel} 已请求 CDP 重连，等待 impaas WS...`);
      await new Promise((r) => setTimeout(r, IMPAAS_RECONNECT_WAIT_MS));
      const refreshed = findBridgeByShopTitle(bridge.shopTitle) || bridge;
      bridge = refreshed;
      if (isBridgeCdpReady(refreshed)) {
        await installWsHook(refreshed.client);
      }
      if (await hasLiveImpaasWs(refreshed)) return true;
    }
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
  if (!client?.Runtime) return false;
  const { Runtime, Page } = client;
  try {
    await cdpAddScriptToEvaluateOnNewDocument(Page, WS_HOOK_SCRIPT);
  } catch {
    // ignore
  }
  await cdpRuntimeEvaluate(Runtime, { expression: WS_HOOK_SCRIPT, returnByValue: true }).catch(() => {});
  await installNativeSyncBridge(client);
  return true;
}

async function sendViaCdpNetwork(bridge, payloadStr, appCid, options = {}) {
  if (!isBridgeCdpReady(bridge) || !bridge.client?.Network) {
    return { ok: false, reason: 'cdp_not_ready' };
  }

  const preferredRequestId = String(options.preferredRequestId || '').trim();
  const ranked = listSendCandidateSessions(bridge, appCid);
  const ordered = preferredRequestId
    ? [
        ...ranked.filter((s) => s.requestId === preferredRequestId),
        ...ranked.filter((s) => s.requestId !== preferredRequestId),
      ]
    : ranked;

  for (const sess of ordered) {
    try {
      await cdpNetworkSendWebSocketFrame(bridge.client.Network, {
        requestId: sess.requestId,
        opcode: 1,
        data: payloadStr,
      });
      return {
        ok: true,
        method: preferredRequestId && sess.requestId === preferredRequestId ? 'cdp_ws_manual' : 'cdp_ws',
        url: sess.url || bridge.wsUrls.get(sess.requestId) || '',
        requestId: sess.requestId,
        rank: scoreSendSession(sess, appCid),
        count: ordered.length,
      };
    } catch (err) {
      println(
        `[千帆发送] CDP WS 发送失败 requestId=${sess.requestId}: ${err.message || err}`
      );
    }
  }

  return { ok: false, reason: 'cdp_ws_send_failed', count: ordered.length };
}

async function trySendWithRecentManualWs(bridge, payloadStr, appCid) {
  const manual = getRecentManualSendSample(bridge, appCid);
  if (!manual?.requestId) return null;

  println(
    `[千帆发送] 复用最近 WS 样本 requestId=${manual.requestId} appCid=${manual.appCid || appCid}`
  );
  const sent = await sendViaPageRuntime(bridge.client, payloadStr, appCid);
  return sent.ok ? sent : null;
}

function getWsWakeProbeConfig() {
  const qd = config.qianfanDebug || {};
  const buyerNick = String(qd.wsWakeBuyerNick || '饭饭').trim() || '饭饭';
  assertSendAllowedForBuyer(buyerNick, 'ws_wake_probe_config');
  return {
    buyerNick,
    text: String(qd.wsWakeText || '亲亲').trim() || '亲亲',
  };
}

async function waitForFreshManualSendCapture(bridge, sinceMs, timeoutMs = WS_WAKE_CAPTURE_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const samples = [];
    if (bridge.lastManualSendAny) samples.push(bridge.lastManualSendAny);
    for (const sample of bridge.lastManualSendByAppCid.values()) {
      samples.push(sample);
    }
    for (const sample of samples) {
      if (!sample?.requestId) continue;
      const capturedAt = Number(sample.capturedAt || 0);
      if (capturedAt >= sinceMs) {
        return {
          ...sample,
          capturedAt,
          session: bridge.wsSessions.get(sample.requestId) || null,
        };
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function beginWsCaptureForRecovery(bridge) {
  if (!isBridgeCdpReady(bridge)) return false;
  try {
    if (bridge.client?.Network) {
      await cdpNetworkEnable(bridge.client.Network);
    }
    await installWsHook(bridge.client);
    await installUiSyncBridge(bridge.client);
    return true;
  } catch (err) {
    println(`[千帆发送] 开启 WS 捕获失败：${err.message || err}`);
    return false;
  }
}

async function recoverImpaasWsViaUiProbe(bridge, shopTitle) {
  const shopLabel = normalizeShopKey(shopTitle);
  const wake = getWsWakeProbeConfig();
  assertSendAllowedForBuyer(wake.buyerNick, 'ui_ws_probe');
  if (!isBridgeCdpReady(bridge)) {
    return { ok: false, reason: 'cdp_not_ready' };
  }

  println(
    `[千帆发送] ${shopLabel} WS 不可用：从此刻开启捕获 → UI 向「${wake.buyerNick}」探针发消息 → 抓到 WS 后重试原买家`
  );

  const captureReady = await beginWsCaptureForRecovery(bridge);
  if (!captureReady) {
    return { ok: false, reason: 'capture_not_ready' };
  }

  const captureStartedAt = Date.now();
  const uiSent = await sendBuyerTextViaUi(bridge.client, {
    appCid: '',
    text: wake.text,
    buyerNick: wake.buyerNick,
  });
  if (!uiSent.ok) {
    println(
      `[千帆发送] ${shopLabel} UI 探针发送失败 buyer=${wake.buyerNick} reason=${uiSent.reason || 'unknown'}`
    );
    return { ok: false, reason: uiSent.reason || 'wake_ui_failed' };
  }

  println(
    `[千帆发送] ${shopLabel} UI 探针已发送 buyer=${wake.buyerNick} method=${uiSent.method || 'ui'}，等待捕获 /message/send WS...`
  );

  const captured = await waitForFreshManualSendCapture(bridge, captureStartedAt);
  if (!captured?.requestId) {
    println(`[千帆发送] ${shopLabel} 探针后未捕获到新鲜 WS 样本（${WS_WAKE_CAPTURE_WAIT_MS}ms 超时）`);
    const probed = await probePageImpaasWs(bridge);
    if (probed.ok) {
      println(`[千帆发送] ${shopLabel} 探针后页面 WS 已可用，继续重试原买家`);
      return { ok: true, manual: null, probePageOnly: true };
    }
    return { ok: false, reason: 'capture_timeout' };
  }

  println(
    `[千帆发送] ${shopLabel} 已捕获探针 WS requestId=${captured.requestId} probeAppCid=${captured.appCid || ''}`
  );
  return { ok: true, manual: captured };
}

async function retryWsSendAfterCapture(bridge, payloadStr, appCid, manual) {
  if (isBridgeCdpReady(bridge)) {
    await installWsHook(bridge.client);
    await cdpRuntimeEvaluate(bridge.client.Runtime, {
      expression: `(function(){
        if (window.__qfRehookImpaasSockets) window.__qfRehookImpaasSockets();
        return true;
      })()`,
      returnByValue: true,
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, IMPAAS_WAKE_WAIT_MS));
  }

  const pageSent = await sendViaPageRuntime(bridge.client, payloadStr, appCid);
  if (pageSent.ok) return pageSent;

  const manualSent = await trySendWithRecentManualWs(bridge, payloadStr, appCid);
  if (manualSent?.ok) return manualSent;

  return { ok: false, reason: 'no_ws' };
}

async function sendViaPageRuntime(client, payloadStr, appCid) {
  if (!client?.Runtime) return { ok: false, reason: 'cdp_not_ready' };
  const { Runtime } = client;
  for (let i = 0; i < 8; i++) {
    try {
      const result = await cdpRuntimeEvaluate(Runtime, {
      expression: `(function(){
        var appCid = ${JSON.stringify(appCid || '')};
        var payloadStr = ${JSON.stringify(payloadStr)};
        if (window.__qfRehookImpaasSockets) window.__qfRehookImpaasSockets();
        var pick = window.__qfPickSendSocket && window.__qfPickSendSocket(appCid);
        var list = (window.__qfImpaasSockets || []).filter(function(w){ return w && w.readyState === 1; });
        var ws = null;
        if (pick && pick.ok) {
          ws = list.find(function(w){ return w && w.readyState === 1 && String(w.url||'') === pick.url; });
        }
        if (!ws) ws = list.find(function(w){ return w && w.readyState === 1 && (w.__qfSendRank || 0) >= 100; });
        if (!ws) ws = list.find(function(w){ return w && w.readyState === 1; });
        if (ws) {
          ws.send(payloadStr);
          return { ok: true, url: String(ws.url || ''), rank: ws.__qfSendRank || 0, count: list.length, method: 'page_ws' };
        }
        if (window.__qfSendWsPayload) {
          var helper = window.__qfSendWsPayload(payloadStr, appCid);
          if (helper && helper.ok) {
            return { ok: true, url: helper.url || '', rank: 0, count: helper.count || list.length, method: 'page_helper' };
          }
        }
        return { ok: false, reason: 'no_ws', count: list.length };
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

function isPastWarmupWindow(bridge) {
  const connectedAt = Number(bridge?.connectedAt || 0);
  if (!connectedAt) return false;
  return Date.now() - connectedAt >= PROBE_MIN_BRIDGE_AGE_MS;
}

async function prewarmShopWsSend(shopTitle) {
  let bridge = findBridgeByShopTitle(shopTitle);
  if (!bridge || !isBridgeCdpReady(bridge)) {
    return { ok: false, reason: 'no_bridge' };
  }
  await installWsHook(bridge.client);
  let probed = await probePageImpaasWs(bridge);
  if (probed.ok) {
    println(`[千帆] 店铺 ${shopTitle} WS发送就绪 open=${probed.count}/${probed.total}`);
    return { ok: true, ...probed };
  }
  println(`[千帆] 店铺 ${shopTitle} WS待建立，后台轻量唤醒（不探针饭饭）...`);
  await ensureImpaasWsReady(bridge, null, { rounds: IMPAAS_QUICK_WAKE_ROUNDS });
  bridge = findBridgeByShopTitle(shopTitle) || bridge;
  await installWsHook(bridge.client);
  probed = await probePageImpaasWs(bridge);
  if (probed.ok) {
    println(`[千帆] 店铺 ${shopTitle} WS发送就绪（唤醒后） open=${probed.count}/${probed.total}`);
  } else {
    println(`[千帆] 店铺 ${shopTitle} WS仍待建立，首次回复时将再试 QuickWake`);
  }
  return { ok: probed.ok, ...probed };
}

function canRunUiProbe(shopTitle) {
  const key = normalizeShopKey(shopTitle);
  const last = shopProbeCooldown.get(key) || 0;
  return Date.now() - last >= PROBE_COOLDOWN_MS;
}

function markUiProbeRan(shopTitle) {
  shopProbeCooldown.set(normalizeShopKey(shopTitle), Date.now());
}

async function isShopWsSendReady(shopTitle) {
  const bridge = findBridgeByShopTitle(shopTitle);
  if (!bridge || !isBridgeCdpReady(bridge)) return false;
  return (await probePageImpaasWs(bridge)).ok;
}

async function tryPageWsSend(bridge, payloadStr, appCid) {
  if (!(await probePageImpaasWs(bridge)).ok) {
    return { ok: false, reason: 'no_page_ws' };
  }
  return sendViaPageRuntime(bridge.client, payloadStr, appCid);
}

/**
 * 千帆 /message/send 投递：Fast → QuickWake → IdleProbe（仅空闲断链 + 冷却）。
 * UI 不参与对客户的回复投递（见 .cursor/rules/qianfan-ws-send-flow.mdc）。
 */
async function sendPayloadToImpaas(bridge, shopTitle, payloadStr, appCid, options = {}) {
  const deadline = Date.now() + SEND_PAYLOAD_BUDGET_MS;
  const buyerNick = String(options.buyerNick || '').trim();
  assertSendAllowedForBuyer(buyerNick, 'ws_send');
  const shopLabel = normalizeShopKey(shopTitle);
  let currentBridge = bridge;

  const remainingMs = () => Math.max(0, deadline - Date.now());

  if (!isBridgeCdpReady(currentBridge)) {
    currentBridge =
      (await waitForBridgeCdpReady(shopTitle, Math.min(IMPAAS_RECONNECT_WAIT_MS, remainingMs()))) ||
      currentBridge;
  }

  if (!isBridgeCdpReady(currentBridge)) {
    return { ok: false, reason: 'cdp_not_ready' };
  }

  await installWsHook(currentBridge.client);
  noteBuyerAppCidOnBridge(currentBridge.shopTitle, appCid);
  if (appCid && currentBridge.lastMessageListRequest) {
    await fetchMessageListForAppCid(currentBridge, appCid);
  }

  // Phase A — Fast（0–2s，跳过 cdp_ws）
  println(`[千帆发送] ${shopLabel} Phase A 快速 WS 发送...`);
  const manualSent = await trySendWithRecentManualWs(currentBridge, payloadStr, appCid);
  if (manualSent?.ok) return manualSent;

  let sent = await tryPageWsSend(currentBridge, payloadStr, appCid);
  if (sent.ok) return sent;

  if (remainingMs() <= 0) return { ok: false, reason: 'send_timeout' };

  // Phase B — QuickWake（单次轻量重连 ~5–6s）
  println(`[千帆发送] ${shopLabel} Phase B 轻量重连唤醒...`);
  currentBridge = findBridgeByShopTitle(shopTitle) || currentBridge;
  const woke = await ensureImpaasWsReady(currentBridge, appCid, { rounds: IMPAAS_QUICK_WAKE_ROUNDS });
  if (woke) {
    currentBridge = findBridgeByShopTitle(shopTitle) || currentBridge;
    await installWsHook(currentBridge.client);
  }
  sent = await tryPageWsSend(currentBridge, payloadStr, appCid);
  if (sent.ok) return sent;

  if (remainingMs() <= 0) return { ok: false, reason: 'send_timeout' };

  // Phase C — 运行一段时间后 WS 仍不可用：UI 探针饭饭 → 捕获 → WS 重试
  currentBridge = findBridgeByShopTitle(shopTitle) || currentBridge;

  if (!isPastWarmupWindow(currentBridge)) {
    println(`[千帆发送] ${shopLabel} 刚接入（<${PROBE_MIN_BRIDGE_AGE_MS / 1000}s），跳过 UI 探针，请稍后再试`);
    return { ok: false, reason: 'ws_warming' };
  }

  if (!canRunUiProbe(shopTitle)) {
    println(`[千帆发送] ${shopLabel} UI 探针冷却中（${PROBE_COOLDOWN_MS / 1000}s），跳过`);
    return { ok: false, reason: 'probe_cooldown' };
  }

  markUiProbeRan(shopTitle);
  println(`[千帆发送] ${shopLabel} Phase C 空闲断链 UI 探针恢复...`);
  const recovered = await recoverImpaasWsViaUiProbe(currentBridge, shopTitle);
  if (recovered.ok) {
    currentBridge = findBridgeByShopTitle(shopTitle) || currentBridge;
    await installWsHook(currentBridge.client);
    println(`[千帆发送] ${shopLabel} 探针 WS 已捕获，WS 重试原买家消息...`);
    sent = await retryWsSendAfterCapture(currentBridge, payloadStr, appCid, recovered.manual);
    if (sent.ok) {
      println(`[千帆发送] ${shopLabel} 探针恢复后 WS 重试成功 method=${sent.method || 'ws'}`);
      return sent;
    }
    println(`[千帆发送] ${shopLabel} 探针恢复后 WS 重试仍失败 reason=${sent.reason || 'no_ws'}`);
  }

  return { ok: false, reason: sent?.reason || 'no_ws' };
}

function findBridgeByShopTitle(shopTitle) {
  const key = normalizeShopKey(shopTitle);
  if (!key) return null;

  for (const [registered, bridge] of bridges) {
    if (normalizeShopKey(registered) === key) return bridge;
  }

  for (const [registered, bridge] of bridges) {
    const registeredKey = normalizeShopKey(registered);
    if (!registeredKey) continue;
    if (registeredKey.includes(key) || key.includes(registeredKey)) return bridge;
    const strippedRegistered = registeredKey.replace(/^XY/i, '');
    const strippedKey = key.replace(/^XY/i, '');
    if (strippedRegistered && strippedKey && strippedRegistered === strippedKey) return bridge;
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

  if (client?.Network) {
    await cdpNetworkEnable(client.Network);
  }
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
    lastWsFrameAt: prev?.lastWsFrameAt || 0,
    frameListeners: prev?.frameListeners || new Set(),
    buyerMessageHandlers: prev?.buyerMessageHandlers || new Set(),
    httpTemplates: prev?.httpTemplates || new Map(),
    wsSessions: new Map(),
    wsUrls: new Map(),
    lastManualSendByAppCid: prev?.lastManualSendByAppCid || new Map(),
    lastManualSendAny: prev?.lastManualSendAny || null,
    lastManualImageSendByAppCid: prev?.lastManualImageSendByAppCid || new Map(),
    lastManualImageSendAny: prev?.lastManualImageSendAny || null,
    lastMessageListRequest: prev?.lastMessageListRequest || null,
    wsHandshakeHeaders: prev?.wsHandshakeHeaders || new Map(),
    wsHandshakeResponses: prev?.wsHandshakeResponses || new Map(),
    recentWsHeartbeatFrames: prev?.recentWsHeartbeatFrames || [],
    lastSeenUrl: prev?.lastSeenUrl || String(pageInfo?.url || pageInfo?.lastSeenUrl || ''),
  };

  const { Network } = client;
  Network.webSocketCreated(({ requestId, url }) => {
    const wsUrl = String(url || '');
    bridge.wsUrls.set(requestId, wsUrl);
    if (wsUrl.includes('impaas') || wsUrl.includes('longlink') || wsUrl.includes('walle')) {
      try {
        const { onWsConnected } = require('./qianfan-cookie-collector');
        onWsConnected(shopTitle);
      } catch {
        // ignore
      }
    }
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
    const reqUrl = String(request?.url || '');
    if (reqUrl) bridge.lastSeenUrl = reqUrl;
    const cookieHeader = request?.headers?.Cookie || request?.headers?.cookie || '';
    if (cookieHeader) {
      try {
        const { noteBridgeRequestCookie } = require('./qianfan-cookie-collector');
        noteBridgeRequestCookie(bridge, cookieHeader, String(request?.url || ''));
      } catch {
        // ignore cookie collector errors
      }
    }
  });

  Network.responseReceived(({ response }) => {
    const status = Number(response?.status || 0);
    if (status === 401 || status === 403) {
      try {
        const { onAuthError } = require('./qianfan-cookie-collector');
        onAuthError(shopTitle);
      } catch {
        // ignore
      }
    }
  });

  try {
    Network.webSocketWillSendHandshakeRequest(({ requestId, request }) => {
      try {
        const url = String(bridge.wsUrls.get(requestId) || request?.url || '');
        if (!isRelevantProtocolWsUrl(url)) return;
        bridge.wsHandshakeHeaders.set(requestId, {
          requestId,
          url,
          requestHeaders: { ...(request?.headers || {}) },
          capturedAt: Date.now(),
        });
      } catch {
        // ignore handshake capture errors
      }
    });
  } catch {
    // CDP may not expose webSocketWillSendHandshakeRequest
  }

  try {
    Network.webSocketHandshakeResponseReceived(({ requestId, response }) => {
      try {
        const url = String(bridge.wsUrls.get(requestId) || '');
        if (!isRelevantProtocolWsUrl(url)) return;
        bridge.wsHandshakeResponses.set(requestId, {
          requestId,
          url,
          responseHeaders: { ...(response?.headers || {}) },
          status: Number(response?.status || 0),
          capturedAt: Date.now(),
        });
      } catch {
        // ignore handshake capture errors
      }
    });
  } catch {
    // CDP may not expose webSocketHandshakeResponseReceived
  }

  Network.webSocketFrameReceived((params) => {
    const payload = params.response?.payloadData;
    if (!payload) return;
    if (payload === 'ping' || payload === 'pong') {
      noteWsHeartbeatFrame(bridge, payload, 'received', params.requestId);
      return;
    }
    dispatchFrameListeners(bridge, payload, 'received', params.requestId);
  });

  Network.webSocketFrameSent((params) => {
    const payload = params.response?.payloadData;
    if (!payload) return;
    if (payload === 'ping' || payload === 'pong') {
      noteWsHeartbeatFrame(bridge, payload, 'sent', params.requestId);
      return;
    }
    dispatchFrameListeners(bridge, payload, 'sent', params.requestId);
  });

  bridges.set(shopTitle, bridge);
  bridges.set(normalizeShopKey(shopTitle), bridge);
  try {
    const { onBridgeRegistered } = require('./qianfan-cookie-collector');
    onBridgeRegistered(bridge);
  } catch {
    // ignore
  }
  return bridge;
}

async function sendQianfanTextReply({ shopTitle, appCid, receiverAppUids, text, buyerNick = '', strictTarget = false }) {
  let bridge = findBridgeByShopTitle(shopTitle);
  if (!bridge) {
    throw new Error(`未找到店铺「${normalizeShopKey(shopTitle)}」的千帆发送桥，请确认该店铺工作台已打开`);
  }

  const shopLabel = normalizeShopKey(shopTitle);
  bridge = await prepareShopSendBridge(bridge, shopTitle, appCid);

  const sessionContext = getSessionContext(shopTitle, appCid);
  const effectiveBuyerNick = String(buyerNick || (!strictTarget && sessionContext?.buyerNick) || '').trim();
  assertSendAllowedForBuyer(effectiveBuyerNick, 'sendQianfanTextReply');

  let finalReceiverAppUids = [...(receiverAppUids || [])].filter(Boolean);
  if (!strictTarget) {
    if (!finalReceiverAppUids.length && sessionContext?.receiverAppUids?.length) {
      finalReceiverAppUids = [...sessionContext.receiverAppUids];
    }
  }

  if (!isValidAppCid(appCid)) {
    throw new Error(`会话 appCid 无效（${appCid || '空'}），请等待该买家再次发消息后再回复`);
  }

  const manualForCid = strictTarget ? null : bridge.lastManualSendByAppCid.get(appCid) || null;
  const manualTemplate = isUsableTextManualTemplate(manualForCid, appCid) ? manualForCid : null;
  if (!strictTarget && !finalReceiverAppUids.length && manualForCid?.receiverAppUids?.length) {
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

  if (built.manualTemplateUsed && manualTemplate?.bodySummary) {
    printPayloadDiff(manualTemplate.bodySummary, summarizeBody(built.payload.body));
  } else if (manualForCid && !built.manualTemplateUsed) {
    println('[千帆发送] 跳过非文本手动样本，使用标准文本 payload');
  } else if (!manualTemplate) {
    println('[千帆发送] 无可用手动样本，使用默认 payload 结构');
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
    shopId: shopLabel,
    appCid,
    conversationId: appCid,
    buyerId: finalReceiverAppUids,
    receiverAppUids: finalReceiverAppUids,
    text,
    traceId: ctx.traceId,
    ackId: ctx.traceId,
    sMid: ctx.sMid,
    uuid: ctx.uuid,
    clientMsgId: ctx.uuid,
    seq: ctx.seq,
    sendSessionRequestId: sendSession?.requestId || null,
    payload: built.payload,
    cmd: built.payload?.header?.action,
    action: built.payload?.header?.action,
    gotAck: false,
    gotMessagePush: false,
    gotConversationUpdate: false,
    bubbleInserted: false,
    countdownCleared: false,
  });

  writeBotSendSample({
    shopTitle: shopLabel,
    appCid,
    receiverAppUids: finalReceiverAppUids,
    text,
    payload: built.payload,
    bodySummary: summarizeBody(built.payload.body),
    manualTemplateUsed: Boolean(built.manualTemplateUsed),
  });

  ctx.appCid = appCid;

  const sent = await sendPayloadToImpaas(bridge, shopTitle, built.payloadStr, appCid, {
    buyerNick: effectiveBuyerNick,
  });
  bridge = findBridgeByShopTitle(shopTitle) || bridge;
  if (!sent.ok) {
    writeSendDebug({ event: 'send_fail', reason: sent.reason || 'no_ws', ...ctx });
    let msg;
    if (sent.reason === 'ws_warming') {
      msg = `店铺「${shopLabel}」千帆 WS 预热中，请 3 秒后再试`;
    } else if (sent.reason === 'probe_cooldown') {
      msg = `店铺「${shopLabel}」WS 恢复探针冷却中，请稍后再试或到千帆手动回复一次`;
    } else if (sent.reason === 'send_timeout') {
      msg = `店铺「${shopLabel}」千帆发送超时，请到千帆手动确认是否已发出`;
    } else {
      msg = `店铺「${shopLabel}」消息未能发出（WS 不可用），请确认该店铺工作台页面已打开，或到千帆手动回复一次`;
    }
    throw new Error(msg);
  }

  writeSendDebug({
    event: 'ws_send_called',
    wsUrl: sent.url,
    wsRank: sent.rank,
    wsCount: sent.count,
    sendMethod: sent.method || 'page_ws',
    ...ctx,
  });

  const sentAtMs = Date.now();
  let ack;
  try {
    ack = await waitForSendAck(bridge, ctx, sentAtMs, ACK_TIMEOUT_MS);
  } catch (err) {
    writeSendDebug({ event: 'ack_fail', error: String(err.message || err), ...ctx });
    throw err;
  }

  writeSendDebug({ event: 'ack_ok', qianfanMsgId: ack.msgId, createAt: ack.createAt, ackSource: ack.ackSource || 'cdp', ...ctx });
  println(`[千帆] ACK 成功，msgId=${ack.msgId} traceId=${ctx.traceId}`);

  bridge.lastSeq = seq;
  if (sendSession) sendSession.lastSeq = seq;

  void finalizeSendAfterAck({
    bridge,
    shopLabel,
    appCid,
    text,
    ack,
    ctx,
    built,
    finalReceiverAppUids,
    sessionContext,
    sentAtMs,
  }).catch((err) => {
    println(`[千帆] 发送后同步失败（不影响 ACK）：${err.message || err}`);
  });

  return {
    ...ack,
    ackConfirmed: true,
    echoVerified: false,
    echoReason: 'deferred',
  };
}

async function finalizeSendAfterAck({
  bridge,
  shopLabel,
  appCid,
  text,
  ack,
  ctx,
  built,
  finalReceiverAppUids,
  sessionContext,
  sentAtMs,
}) {
  const pcSync = await (async () => {
    try {
      return await withTimeout(
        triggerNativeSyncAfterAck({
          bridge,
          shopTitle: bridge.shopTitle,
          appCid,
          text,
          ack,
          ackParsed: ack.ackParsed,
          receiverAppUids: finalReceiverAppUids,
          seq: ctx.seq,
          chatId: sessionContext?.chatId || extractChatIdFromBridge(bridge) || null,
          token: sessionContext?.staffToken || '1#1#4#4333439630',
          fixMode: 'ack_then_native_sync',
        }),
        UI_SYNC_TIMEOUT_MS,
        'triggerNativeSyncAfterAck'
      );
    } catch (err) {
      println(`[千帆] PC 原生同步失败（不影响 ACK）：${err.message || err}`);
      return {
        event: 'send_final',
        fixMode: 'ack_then_native_sync',
        ackOk: true,
        msgId: ack.msgId,
        failedReason: String(err.message || err),
        directDomMutationUsed: false,
      };
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

  const sendSummary = {
    shopId: shopLabel,
    buyerId: finalReceiverAppUids,
    conversationId: appCid,
    staffId: built.payload?.body?.staffId || built.payload?.body?.operatorId || null,
    clientMsgId: ctx.uuid,
    msgId: ack.msgId,
    seq: ctx.seq,
    ackId: ctx.traceId,
    cmd: built.payload?.header?.action,
    action: built.payload?.header?.action,
    gotAck: true,
    gotMessagePush: echo.verified,
    gotConversationUpdate: Boolean(pcSync?.conversationUpdatedByQianfan),
    bubbleInserted: Boolean(pcSync?.pcBubbleInsertedByQianfan),
    countdownCleared: Boolean(pcSync?.pcCountdownClearedByQianfan),
    popupCleared: Boolean(pcSync?.pcPopupClearedByQianfan),
    directDomMutationUsed: false,
    payloadSummary: summarizePayload(built.payload),
  };

  writeSendDebug({
    event: 'send_final',
    fixMode: pcSync?.fixMode || 'ack_then_native_sync',
    ...sendSummary,
    httpMessageFound: pcSync?.httpMessageFound,
    syncPushReceived: pcSync?.syncPushReceived,
    nativeSyncHandlerCalled: pcSync?.nativeSyncHandlerCalled,
    readFromOneSent: pcSync?.readFromOneSent,
    messageListRefreshTriggered: pcSync?.messageListRefreshTriggered,
    conversationListRefreshTriggered: pcSync?.conversationListRefreshTriggered,
    pcBubbleInsertedByQianfan: pcSync?.pcBubbleInsertedByQianfan,
    pcCountdownClearedByQianfan: pcSync?.pcCountdownClearedByQianfan,
    pcPopupClearedByQianfan: pcSync?.pcPopupClearedByQianfan,
    conversationUpdatedByQianfan: pcSync?.conversationUpdatedByQianfan,
    directDomMutationUsed: false,
    failedReason: pcSync?.failedReason || null,
  });

  if (echo.verified) {
    println(`[千帆] 回显验证：成功 msgId=${echo.msgId || ack.msgId}（${echo.reason}）`);
    writeSendDebug({
      event: 'echo_ok',
      echoReason: echo.reason,
      qianfanMsgId: ack.msgId,
      ...ctx,
      ...sendSummary,
    });
  } else {
    println('[千帆] 回显验证：未捕获（PC 客服台可能未刷新，不影响 ACK 成功判定）');
    writeSendDebug({
      event: 'echo_optional_miss',
      echoReason: echo.reason,
      qianfanMsgId: ack.msgId,
      ...ctx,
      ...sendSummary,
    });
  }
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
  for (const cid of bridge.lastManualSendByAppCid?.keys?.() || []) {
    const s = String(cid || '').trim();
    if (s) set.add(s);
  }
  return [...set];
}

function resolveReplyContextFromBridge(shopTitle, buyerNick = '') {
  const bridge = findBridgeByShopTitle(shopTitle);
  if (!bridge) return null;

  const shopKey = normalizeShopKey(shopTitle);
  const nick = String(buyerNick || '').trim();

  const cached = findReceiverCacheForShop(shopKey, nick);
  if (cached?.receiverAppUids?.length) return cached;

  for (const appCid of getBridgeActiveAppCids(bridge)) {
    const ctx = getSessionContext(shopKey, appCid);
    if (ctx) {
      if (nick && ctx.buyerNick && !buyerNickMatches(ctx.buyerNick, nick)) continue;
      const receiverAppUids = ctx.receiverAppUids?.length
        ? [...ctx.receiverAppUids]
        : getReceiverAppUids(shopKey, appCid);
      if (receiverAppUids.length) {
        return {
          shopTitle: shopKey,
          appCid,
          buyerNick: String(ctx.buyerNick || nick || '买家').trim(),
          receiverAppUids,
        };
      }
    }
  }

  for (const [appCid, sample] of bridge.lastManualSendByAppCid?.entries?.() || []) {
    const manualUids = Array.isArray(sample?.receiverAppUids)
      ? sample.receiverAppUids.map((u) => String(u || '').trim()).filter(Boolean)
      : [];
    const receiverAppUids = manualUids.length ? manualUids : getReceiverAppUids(shopKey, appCid);
    if (!receiverAppUids.length) continue;
    const ctx = getSessionContext(shopKey, appCid);
    if (nick && ctx?.buyerNick && !buyerNickMatches(ctx.buyerNick, nick)) continue;
    return {
      shopTitle: shopKey,
      appCid: String(appCid),
      buyerNick: String(ctx?.buyerNick || nick || '买家').trim(),
      receiverAppUids,
    };
  }

  const activeCids = getBridgeActiveAppCids(bridge);
  if (activeCids.length === 1) {
    const appCid = activeCids[0];
    const manual = bridge.lastManualSendByAppCid.get(appCid);
    const receiverAppUids = manual?.receiverAppUids?.length
      ? manual.receiverAppUids
      : getReceiverAppUids(shopKey, appCid);
    if (receiverAppUids.length) {
      return {
        shopTitle: shopKey,
        appCid,
        buyerNick: nick || '买家',
        receiverAppUids,
      };
    }
  }

  return null;
}

async function resolveReplyContextForSend(shopTitle, buyerNick = '', appCidHint = '') {
  const shopKey = normalizeShopKey(shopTitle);
  const nick = String(buyerNick || '').trim();
  const hintedAppCid = String(appCidHint || '').trim();
  const bridge = findBridgeByShopTitle(shopTitle);
  if (!bridge) return null;

  if (nick) {
    const batch = await fetchMessageListRaw(bridge);
    if (batch.ok) {
      const messages = extractMessagesFromResponse(batch.body, shopKey, 'http_message_list');
      const picked = pickBuyerMessageForNick(messages, nick);
      const fromMessage = buildReplyContextFromMessage(shopKey, picked);
      if (fromMessage) {
        rememberReceiverAppUids(shopKey, fromMessage.appCid, fromMessage.receiverAppUids);
        saveSessionContext({
          shopTitle: shopKey,
          appCid: fromMessage.appCid,
          buyerNick: fromMessage.buyerNick,
          senderAppUid: fromMessage.receiverAppUids[0],
          receiverAppUids: fromMessage.receiverAppUids,
          createAt: Date.now(),
        });
        return fromMessage;
      }
    }
  }

  if (hintedAppCid) {
    const fetched = await fetchMessageListForAppCid(bridge, hintedAppCid);
    if (fetched.ok) {
      const messages = extractMessagesFromResponse(fetched.body, shopKey);
      const picked = pickBuyerMessageForNick(messages, nick);
      const fromMessage = buildReplyContextFromMessage(shopKey, picked);
      if (fromMessage) {
        rememberReceiverAppUids(shopKey, fromMessage.appCid, fromMessage.receiverAppUids);
        saveSessionContext({
          shopTitle: shopKey,
          appCid: fromMessage.appCid,
          buyerNick: fromMessage.buyerNick,
          senderAppUid: fromMessage.receiverAppUids[0],
          receiverAppUids: fromMessage.receiverAppUids,
          createAt: Date.now(),
        });
        return fromMessage;
      }
    }
  }

  for (const appCid of getBridgeActiveAppCids(bridge)) {
    const ctx = getSessionContext(shopKey, appCid);
    if (!ctx) continue;
    if (nick && ctx.buyerNick && !buyerNickMatches(ctx.buyerNick, nick)) continue;
    const receiverAppUids = ctx.receiverAppUids?.length
      ? [...ctx.receiverAppUids]
      : getReceiverAppUids(shopKey, appCid);
    if (!receiverAppUids.length) continue;
    return {
      shopTitle: shopKey,
      appCid,
      buyerNick: String(ctx.buyerNick || nick || '买家').trim(),
      receiverAppUids,
    };
  }

  return null;
}

function listRegisteredShops() {
  return [...bridges.keys()];
}

function getAllQianfanBridges() {
  const seen = new Set();
  const out = [];
  for (const bridge of bridges.values()) {
    if (!bridge || seen.has(bridge)) continue;
    seen.add(bridge);
    out.push(bridge);
  }
  return out;
}

function getQianfanBridgeByShopTitle(shopTitle) {
  return findBridgeByShopTitle(shopTitle);
}

function serializeManualSendMap(map) {
  const out = {};
  if (!map || typeof map.entries !== 'function') return out;
  for (const [appCid, sample] of map.entries()) {
    out[appCid] = {
      appCid: sample?.appCid || appCid,
      requestId: sample?.requestId || '',
      receiverAppUids: sample?.receiverAppUids || [],
      capturedAt: sample?.capturedAt || 0,
      bodySummary: sample?.bodySummary || null,
      payload: sample?.payload || null,
    };
  }
  return out;
}

function serializeHttpTemplates(httpTemplates) {
  const out = {};
  if (!httpTemplates || typeof httpTemplates.entries !== 'function') return out;
  for (const [pathKey, tpl] of httpTemplates.entries()) {
    out[pathKey] = {
      pathKey: tpl?.pathKey || pathKey,
      url: tpl?.url || '',
      method: tpl?.method || 'POST',
      headers: tpl?.headers || {},
      bodyTemplate: tpl?.bodyTemplate || '',
    };
  }
  return out;
}

function serializeWsCandidates(bridge) {
  const candidates = [];
  for (const sess of bridge.wsSessions?.values() || []) {
    const url = String(sess.url || bridge.wsUrls.get(sess.requestId) || '');
    if (!url || !isRelevantProtocolWsUrl(url)) continue;
    let score = 0;
    if (/longlink/i.test(url)) score += 100;
    if (/impaas/i.test(url)) score += 90;
    if (sess.seenMessageSend) score += 60;
    if (sess.seenBuyerSync) score += 50;
    if (sess.seenImpaasTraffic) score += 30;
    if (WS_PROTOCOL_EXCLUDE_RE.test(url)) score -= 100;
    candidates.push({
      requestId: sess.requestId,
      url,
      score,
      lastSeq: sess.lastSeq || 0,
      lastActivityAt: sess.lastActivityAt || 0,
      seenMessageSend: Boolean(sess.seenMessageSend),
      seenReadFromOne: Boolean(sess.seenReadFromOne),
      seenBuyerSync: Boolean(sess.seenBuyerSync),
      seenImpaasTraffic: Boolean(sess.seenImpaasTraffic),
      appCids: [...(sess.appCids || [])],
    });
  }
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      b.lastActivityAt - a.lastActivityAt ||
      b.lastSeq - a.lastSeq
  );
  return candidates;
}

function serializeHandshakeMaps(bridge) {
  const headers = [];
  for (const row of bridge.wsHandshakeHeaders?.values() || []) headers.push(row);
  const responses = [];
  for (const row of bridge.wsHandshakeResponses?.values() || []) responses.push(row);
  return { headers, responses };
}

function listSessionContextsForShop(shopTitle) {
  const shopKey = normalizeShopKey(shopTitle);
  if (!shopKey) return [];
  try {
    const { readJson } = require('./shared/safe-json-store');
    const { resolveDataDir } = require('./shared/app-root');
    const pathMod = require('path');
    const file = pathMod.join(resolveDataDir(), 'qianfan-session-context.json');
    const all = readJson(file, {});
    return Object.entries(all)
      .filter(([key]) => key.startsWith(`${shopKey}::`))
      .map(([, ctx]) => ctx)
      .sort((a, b) => Number(b?.updatedAt || b?.lastBuyerMsgAt || 0) - Number(a?.updatedAt || a?.lastBuyerMsgAt || 0));
  } catch {
    return [];
  }
}

function listReceiverCacheForShop(shopTitle) {
  const shopKey = normalizeShopKey(shopTitle);
  if (!shopKey) return [];
  try {
    const { readJson } = require('./shared/safe-json-store');
    const { resolveDataDir } = require('./shared/app-root');
    const pathMod = require('path');
    const file = pathMod.join(resolveDataDir(), 'app-cid-receivers.json');
    const all = readJson(file, {});
    return Object.entries(all)
      .filter(([key]) => key.startsWith(`${shopKey}::`))
      .map(([key, uids]) => ({ key, receiverAppUids: Array.isArray(uids) ? uids : [] }));
  } catch {
    return [];
  }
}

async function probePageImpaasWsUrls(bridge) {
  if (!isBridgeCdpReady(bridge)) return [];
  try {
    await installWsHook(bridge.client);
    const result = await cdpRuntimeEvaluate(bridge.client.Runtime, {
      expression: `(function(){
        if (window.__qfRehookImpaasSockets) window.__qfRehookImpaasSockets();
        var list = window.__qfImpaasSockets || [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var w = list[i];
          if (!w) continue;
          var u = String(w.url || '');
          if (!u) continue;
          out.push({
            url: u,
            readyState: Number(w.readyState || 0),
            score: Number(w.__qfSendRank || 0),
            appCids: Array.isArray(w.__qfAppCids) ? w.__qfAppCids.slice() : [],
          });
        }
        return out;
      })()`,
      returnByValue: true,
    });
    return Array.isArray(result?.result?.value) ? result.result.value : [];
  } catch {
    return [];
  }
}

function mergePageWsCandidates(existing, pageWsList) {
  const out = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(out.map((c) => c.url));
  for (const row of pageWsList || []) {
    const url = String(row?.url || '');
    if (!url || !isRelevantProtocolWsUrl(url) || seen.has(url)) continue;
    let score = Number(row.score) || 0;
    if (/longlink/i.test(url)) score += 100;
    if (/impaas/i.test(url)) score += 90;
    if (Number(row.readyState) === 1) score += 40;
    if (Array.isArray(row.appCids) && row.appCids.length) score += 30;
    out.push({
      requestId: `page-${out.length}`,
      url,
      score,
      lastSeq: 0,
      lastActivityAt: Date.now(),
      seenMessageSend: score >= 100,
      seenReadFromOne: false,
      seenBuyerSync: false,
      seenImpaasTraffic: true,
      appCids: [...(row.appCids || [])],
      source: 'page.__qfImpaasSockets',
    });
    seen.add(url);
  }
  out.sort(
    (a, b) =>
      b.score - a.score ||
      b.lastActivityAt - a.lastActivityAt ||
      b.lastSeq - a.lastSeq
  );
  return out;
}

async function enrichAndBuildQianfanProtocolSnapshot(shopTitle, options = {}) {
  const snapshot = buildQianfanProtocolSnapshot(shopTitle, options);
  if (!snapshot.ok) return snapshot;

  const bridge = findBridgeByShopTitle(shopTitle);
  if (!bridge || !isBridgeCdpReady(bridge)) {
    snapshot.enrichSkipped = 'cdp_not_ready';
    return snapshot;
  }

  const enrichNotes = [];
  let mergedCookie = String(snapshot.cookieSources?.mergedNetworkHeaderCookie || '');

  if (!mergedCookie || mergedCookie.length < 20) {
    try {
      const { collectFullCookiesFromBridge } = require('./qianfan-full-cookie-collect');
      const collected = await collectFullCookiesFromBridge(bridge, {
        readOnly: true,
        requireRecentNetworkHeader: false,
        networkHeaderWaitMs: Number(options.cookieWaitMs || 2500),
        includeJarFallback: true,
      });
      if (collected?.cookie && collected.cookie.length >= 20) {
        mergedCookie = collected.cookie;
        bridge.mergedNetworkHeaderCookie = mergeCookiePartsPreferLongestSafe(
          bridge.mergedNetworkHeaderCookie,
          collected.cookie
        );
        enrichNotes.push('cdp_cookie_collect');
      } else if (collected?.skipped) {
        enrichNotes.push(`cookie_skipped:${collected.reason || 'unknown'}`);
      }
    } catch (err) {
      enrichNotes.push(`cookie_error:${String(err.message || err).slice(0, 80)}`);
    }
  }

  if (!snapshot.wsCandidates?.length) {
    const pageWs = await probePageImpaasWsUrls(bridge);
    if (pageWs.length) {
      snapshot.wsCandidates = mergePageWsCandidates(snapshot.wsCandidates, pageWs);
      enrichNotes.push(`page_ws:${pageWs.length}`);
    }
  }

  snapshot.cookieSources = {
    ...snapshot.cookieSources,
    mergedNetworkHeaderCookie: mergedCookie,
  };
  snapshot.enrichedAt = Date.now();
  snapshot.enrichNotes = enrichNotes;
  return snapshot;
}

function mergeCookiePartsPreferLongestSafe(...parts) {
  try {
    const { mergeCookiePartsPreferLongest } = require('./qianfan-full-cookie-collect');
    return mergeCookiePartsPreferLongest(...parts);
  } catch {
    return String(parts.filter(Boolean)[0] || '');
  }
}

function buildQianfanProtocolSnapshot(shopTitle, options = {}) {
  const bridge = findBridgeByShopTitle(shopTitle);
  const normalizedShopTitle = normalizeShopKey(shopTitle);
  if (!bridge) {
    return {
      ok: false,
      error: 'bridge_not_found',
      shopTitle: String(shopTitle || ''),
      normalizedShopTitle,
    };
  }

  let mergedCookie = '';
  try {
    const { mergeBridgeNetworkHeaderCookies } = require('./qianfan-full-cookie-collect');
    mergedCookie = mergeBridgeNetworkHeaderCookies(bridge);
  } catch {
    mergedCookie = String(bridge.mergedNetworkHeaderCookie || bridge.lastRequestCookie || '').trim();
  }

  const wsCandidates = serializeWsCandidates(bridge);
  const handshake = serializeHandshakeMaps(bridge);
  const sessionContexts = listSessionContextsForShop(normalizedShopTitle);
  const receiverCache = listReceiverCacheForShop(normalizedShopTitle);

  return {
    ok: true,
    shopTitle: bridge.shopTitle,
    normalizedShopTitle,
    connectedAt: bridge.connectedAt || 0,
    cdpReady: isBridgeCdpReady(bridge),
    pageInfo: bridge.pageInfo || null,
    lastSeenUrl: bridge.lastSeenUrl || '',
    lastSeq: bridge.lastSeq || 0,
    lastWsFrameAt: bridge.lastWsFrameAt || 0,
    cookieSources: {
      mergedNetworkHeaderCookie: mergedCookie,
      lastArkRequestCookie: bridge.lastArkRequestCookie || '',
      lastOrderRequestCookie: bridge.lastOrderRequestCookie || '',
      lastWalleRequestCookie: bridge.lastWalleRequestCookie || '',
      lastRequestCookie: bridge.lastRequestCookie || '',
    },
    wsCandidates,
    wsHandshake: handshake,
    recentWsHeartbeatFrames: [...(bridge.recentWsHeartbeatFrames || [])],
    httpTemplates: serializeHttpTemplates(bridge.httpTemplates),
    lastMessageListRequest: bridge.lastMessageListRequest
      ? {
          pathKey: bridge.lastMessageListRequest.pathKey,
          url: bridge.lastMessageListRequest.url,
          method: bridge.lastMessageListRequest.method,
          headers: bridge.lastMessageListRequest.headers,
          bodyTemplate: bridge.lastMessageListRequest.bodyTemplate,
        }
      : null,
    lastManualSendAny: bridge.lastManualSendAny?.payload || null,
    lastManualSendByAppCid: serializeManualSendMap(bridge.lastManualSendByAppCid),
    lastManualImageSendAny: bridge.lastManualImageSendAny?.payload || null,
    lastManualImageSendByAppCid: serializeManualSendMap(bridge.lastManualImageSendByAppCid),
    sessionContexts,
    receiverCache,
    includeFullCookie: options.includeFullCookie !== false,
  };
}

module.exports = {
  registerQianfanWsBridge,
  registerBuyerMessageHandler,
  registerShopReconnectWake,
  unregisterShopReconnectWake,
  getBridgeWsActivity,
  isShopWsSendReady,
  probePageImpaasWs,
  prewarmShopWsSend,
  fetchHttpTemplate,
  fetchMessageListForAppCid,
  getBridgeActiveAppCids,
  isBridgeCdpReady,
  markBridgeCdpClosed,
  sendQianfanTextReply,
  findBridgeByShopTitle,
  resolveReplyContextFromBridge,
  resolveReplyContextForSend,
  noteBuyerAppCidOnBridge,
  listRegisteredShops,
  getAllQianfanBridges,
  getQianfanBridgeByShopTitle,
  buildQianfanProtocolSnapshot,
  enrichAndBuildQianfanProtocolSnapshot,
  probePageImpaasWsUrls,
  normalizeShopKey,
  HTTP_CAPTURE_PATHS,
};
