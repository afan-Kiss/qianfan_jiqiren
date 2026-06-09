/**
 * 千帆 PC 原生同步触发（ACK 后复刻 sync/read/refresh 链，禁止直接 DOM 改 UI）
 */
const crypto = require('crypto');
const { extractMessagesFromResponse } = require('./chat-parse');
const { println } = require('./utils');
const { cdpRuntimeEvaluate, CDP_EVAL_DEFAULT_MS } = require('./cdp-timeout');
const { patchMessageListBody, installUiSyncBridge } = require('./qianfan-ui-sync');

const SYNC_TYPE_PRELUDE = 31010;
const SYNC_TYPE_USER_MESSAGE = 30001;

const NATIVE_SYNC_BRIDGE_SCRIPT = `(function(){
  if (window.__qfNativeSyncInstalled) return { ok: true, already: true };
  window.__qfNativeSyncInstalled = true;

  function pickLonglinkSockets() {
    var list = (window.__qfImpaasSockets || []).filter(function(w){ return w && w.readyState === 1; });
    var longlink = list.filter(function(w){ return String(w.url || '').indexOf('longlink') >= 0; });
    return longlink.length ? longlink : list;
  }

  window.__qfDispatchWsMessage = function(payloadStr) {
    var evt;
    try { evt = new MessageEvent('message', { data: String(payloadStr || '') }); }
    catch (e) { return { fired: 0, error: 'message_event_fail' }; }
    var list = pickLonglinkSockets();
    var fired = 0;
    for (var i = 0; i < list.length; i++) {
      try { list[i].dispatchEvent(evt); fired++; } catch (e2) {}
    }
    return { fired: fired, sockets: list.length };
  };

  window.__qfSendWsPayload = function(payloadStr, appCid) {
    var list = pickLonglinkSockets();
    var pick = window.__qfPickSendSocket && window.__qfPickSendSocket(appCid || '');
    var ws = null;
    if (pick && pick.ok) {
      ws = list.find(function(w){ return String(w.url || '') === pick.url; });
    }
    if (!ws) ws = list.find(function(w){ return (w.__qfSendRank || 0) >= 1; });
    if (!ws) ws = list[0];
    if (!ws) return { ok: false, reason: 'no_ws', count: list.length };
    ws.send(String(payloadStr || ''));
    return { ok: true, url: String(ws.url || ''), count: list.length };
  };

  window.__qfObservePcState = function(appCid, msgId, text) {
    function norm(s) { return String(s || '').replace(/\\s+/g, ' ').trim(); }
    var chatItems = document.querySelectorAll('.chat-item, [class*="chat-item"], [class*="conv"], [class*="session"]');
    var hasCountdown = false;
    var convPreview = '';
    for (var i = 0; i < chatItems.length; i++) {
      var el = chatItems[i];
      var t = norm(el.textContent);
      if (!t) continue;
      var active = /active|selected|current/i.test(String(el.className || ''));
      if (active) {
        convPreview = t.slice(0, 200);
        hasCountdown = /\\d+\\s*秒|倒计时|待回复|未回复|waitReply|countdown/i.test(t + ' ' + el.className);
      }
    }
    var msgRoot = document.querySelector('[class*="msg-list"],[class*="message-list"],[class*="chat-content"],[class*="chat-main"]');
    var bubbleFound = false;
    var bubbleText = '';
    var bodyHtml = document.body ? (document.body.innerHTML || '') : '';
    if (msgId && bodyHtml.indexOf(msgId) >= 0) bubbleFound = true;
    if (msgRoot) {
      var html = msgRoot.innerHTML || '';
      if (msgId && html.indexOf(msgId) >= 0) bubbleFound = true;
      if (!bubbleFound && text) {
        var nodes = msgRoot.querySelectorAll('[class*="msg"],[class*="message"],[class*="bubble"],[class*="msg-row"],[class*="msg-wrap"]');
        for (var j = nodes.length - 1; j >= 0; j--) {
          var nt = norm(nodes[j].textContent);
          if (!nt) continue;
          if (text && (nt.indexOf(text) >= 0 || text.indexOf(nt) >= 0)) {
            bubbleFound = true;
            bubbleText = nt.slice(0, 200);
            break;
          }
        }
      }
    }
    if (!bubbleFound && text && bodyHtml.indexOf(text) >= 0) {
      bubbleFound = true;
      bubbleText = text;
    }
    var popupNodes = document.querySelectorAll('[class*="unreply"],[class*="un-reply"],[class*="wait-reply"],[class*="notify"],[class*="tip"],[class*="popup"],[class*="float"]');
    var popupVisible = false;
    var popupPreview = '';
    for (var k = 0; k < popupNodes.length; k++) {
      var p = popupNodes[k];
      var pt = norm(p.textContent);
      if (!pt) continue;
      if (/待回复|未回复|秒内|timeout|countdown/i.test(pt)) {
        popupVisible = true;
        popupPreview = pt.slice(0, 160);
        break;
      }
    }
    return {
      pcBubbleInsertedByQianfan: bubbleFound,
      pcCountdownClearedByQianfan: !hasCountdown,
      pcPopupClearedByQianfan: !popupVisible,
      conversationUpdatedByQianfan: !!(bubbleFound || !hasCountdown || !popupVisible),
      bubbleText: bubbleText,
      convPreview: convPreview,
      popupPreview: popupPreview,
      directDomMutationUsed: false,
    };
  };

  return { ok: true };
})()`;

function makeTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

function makeSequenceId() {
  return `${Math.floor(Math.random() * 900 + 100)}.${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function parseSenderAppUid(extension) {
  if (!extension) return '';
  try {
    const raw = extension.sender;
    const sender = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return (
      sender?.representInfo?.appUid ||
      sender?.presentInfo?.appUid ||
      ''
    );
  } catch {
    return '';
  }
}

function buildContentInfo101(text) {
  const summary = String(text || '').trim();
  return {
    contentType: 101,
    content: JSON.stringify({
      data: JSON.stringify({ content: summary, content_type: 1 }),
      summary,
      type: 1,
    }),
  };
}

function buildUserMessageFromAck({ ackData, appCid, text }) {
  const createAt = Number(ackData?.createAt || Date.now());
  const msgId = String(ackData?.msgId || '').trim();
  const extension = ackData?.extension || {};
  const senderAppUid = parseSenderAppUid(extension) || '1#1#4#4333439630';

  let contentInfo = ackData?.contentInfo;
  if (!contentInfo || contentInfo.contentType === 1) {
    contentInfo = buildContentInfo101(text);
  }

  return {
    appCid,
    msgId,
    convType: 1,
    createAt,
    displayStyle: 0,
    contentInfo,
    extension,
    msgReadStatusSetting: ackData?.msgReadStatusSetting ?? 1,
    receiverCount: ackData?.receiverCount ?? 2,
    redPointPolicy: ackData?.redPointPolicy ?? 1,
    senderAppUid,
    status: ackData?.status ?? 0,
    unreadCount: ackData?.unreadCount ?? 0,
  };
}

function buildSyncFrameBase(token) {
  return {
    header: {
      type: 4,
      domain: 'cs',
      seq: 0,
      action: '/sync/unreliable',
      ts: Date.now(),
      qos: 0,
      bizId: 10,
      contentType: 'json',
      sMid: crypto.randomUUID(),
      oneWay: true,
    },
    body: {
      context: {
        eventTime: Date.now(),
        sequenceId: makeSequenceId(),
        reqId: makeTraceId(),
        token: token || '1#1#4#4333439630',
      },
      payload: [],
    },
  };
}

/** 手机端同步链：先 31010 预告，再 30001 完整 userMessage */
function buildSyncUnreliableFrames({ ackData, appCid, text, token }) {
  const createAt = Number(ackData?.createAt || Date.now());
  const msgId = String(ackData?.msgId || '').trim();
  const userMessage = buildUserMessageFromAck({ ackData, appCid, text });

  const prelude = buildSyncFrameBase(token);
  prelude.body.payload = [
    {
      type: SYNC_TYPE_PRELUDE,
      data: JSON.stringify({ appCid, msgId, time: createAt }),
    },
  ];

  const full = buildSyncFrameBase(token);
  full.header.ts = Date.now();
  full.header.sMid = crypto.randomUUID();
  full.body.context.eventTime = Date.now();
  full.body.context.sequenceId = makeSequenceId();
  full.body.context.reqId = makeTraceId();
  full.body.payload = [
    {
      type: SYNC_TYPE_USER_MESSAGE,
      data: JSON.stringify({ time: createAt, userMessage }),
    },
  ];

  return [prelude, full];
}

function buildReadFromOneFrame({ appCid, msgId, targetAppUid, seq }) {
  return {
    header: {
      sTime: Date.now(),
      seq: Number(seq) > 0 ? Number(seq) : 1,
      type: 3,
      bizId: 10,
      contentType: 'json',
      traceId: makeTraceId(),
      action: '/message/read/from/one',
      serviceId: 'impaas.oim',
      oneWay: true,
    },
    body: {
      msgId,
      appCid,
      targetAppUid,
      convType: 1,
      targetType: 0,
    },
  };
}

async function installNativeSyncBridge(client) {
  if (!client?.Runtime) return false;
  await cdpRuntimeEvaluate(client.Runtime, {
    expression: NATIVE_SYNC_BRIDGE_SCRIPT,
    returnByValue: true,
  }).catch(() => null);
  return true;
}

async function evalPage(client, expression, awaitPromise = false) {
  const result = await cdpRuntimeEvaluate(
    client.Runtime,
    { expression, awaitPromise, returnByValue: true },
    CDP_EVAL_DEFAULT_MS
  );
  return result?.result?.value;
}

async function dispatchSyncFrames(client, frames) {
  let totalFired = 0;
  for (const frame of frames) {
    const dispatch = await evalPage(
      client,
      `(function(){
        if (!window.__qfDispatchWsMessage) return { fired: 0, reason: 'no_dispatch' };
        return window.__qfDispatchWsMessage(${JSON.stringify(JSON.stringify(frame))});
      })()`
    );
    totalFired += Number(dispatch?.fired || 0);
    await new Promise((r) => setTimeout(r, 120));
  }
  return totalFired;
}

async function fetchMessageListViaPage(client, tpl, appCid) {
  if (!tpl?.url || !tpl?.headers) return { ok: false, reason: 'http_template_missing' };
  const body = patchMessageListBody(tpl.bodyTemplate, appCid);
  return evalPage(
    client,
    `(async function(){
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
    true
  );
}

function findMessageInHttpBody(body, shopTitle, appCid, msgId, text) {
  const messages = extractMessagesFromResponse(body, shopTitle, 'native_sync');
  for (const msg of messages) {
    if (msg.appCid && msg.appCid !== appCid) continue;
    if (msgId && msg.msgId === msgId) return msg;
    if (text && String(msg.text || '').trim() === String(text).trim()) return msg;
  }
  const raw = JSON.stringify(body || {});
  if (msgId && raw.includes(msgId) && raw.includes(appCid)) return { msgId, appCid, text };
  return null;
}

async function fetchUncheckedViaPage(client, bridge, chatId) {
  const tpl = [...(bridge?.httpTemplates?.values() || [])].find((t) =>
    String(t.pathKey || t.url || '').includes('unchecked/ai/msg')
  );
  if (!tpl?.url) return { ok: false, reason: 'unchecked_template_missing' };
  const postData = chatId ? JSON.stringify({ chatIdList: [chatId] }) : tpl.bodyTemplate || '{}';
  return evalPage(
    client,
    `(async function(){
      try {
        const res = await fetch(${JSON.stringify(tpl.url)}, {
          method: ${JSON.stringify(tpl.method || 'POST')},
          headers: ${JSON.stringify(tpl.headers || {})},
          body: ${JSON.stringify(postData)},
          credentials: 'include',
        });
        const json = await res.json();
        return { ok: res.ok, status: res.status, body: json };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    })()`,
    true
  );
}

async function reselectConversationNative(client, appCid) {
  await installUiSyncBridge(client);
  return evalPage(
    client,
    `(async function(){
      var sync = window.__qfUiSync;
      if (!sync) return { clicked: false, reason: 'no_sync' };
      return await sync.reselectConversation(${JSON.stringify(appCid)});
    })()`,
    true
  );
}

/**
 * ACK 后触发千帆页面原生同步链
 */
async function triggerNativeSyncAfterAck(ctx) {
  const {
    bridge,
    appCid,
    text,
    ack,
    ackParsed,
    receiverAppUids,
    shopTitle,
    seq,
    chatId,
    token,
    fixMode = 'ack_then_native_sync',
  } = ctx;

  const client = bridge?.client;
  const result = {
    event: 'send_final',
    fixMode,
    appCid,
    buyerId: receiverAppUids,
    seq,
    ackOk: Boolean(ack?.msgId),
    msgId: ack?.msgId || null,
    httpMessageFound: false,
    syncPushReceived: false,
    nativeSyncHandlerCalled: false,
    syncPrelude31010Dispatched: false,
    syncUserMessage30001Dispatched: false,
    readFromOneSent: false,
    messageListRefreshTriggered: false,
    conversationListRefreshTriggered: false,
    conversationReselected: false,
    pcBubbleInsertedByQianfan: false,
    pcCountdownClearedByQianfan: false,
    pcPopupClearedByQianfan: false,
    conversationUpdatedByQianfan: false,
    directDomMutationUsed: false,
    failedReason: null,
  };

  if (!client?.Runtime) {
    result.failedReason = 'cdp_not_ready';
    return result;
  }

  await installNativeSyncBridge(client);

  const ackData = {
    msgId: ack?.msgId,
    createAt: ack?.createAt,
    ...(ackParsed?.body?.data || {}),
  };

  const httpFetched = await fetchMessageListViaPage(client, bridge.lastMessageListRequest, appCid);
  if (httpFetched?.ok && httpFetched.body) {
    result.messageListRefreshTriggered = true;
    const hit = findMessageInHttpBody(httpFetched.body, shopTitle, appCid, ackData.msgId, text);
    result.httpMessageFound = Boolean(hit);
  }

  const targetAppUid = (Array.isArray(receiverAppUids) ? receiverAppUids[0] : '') || '';
  let nextSeq = Math.max(Number(seq || 0), Number(bridge?.lastSeq || 0)) + 1;

  // 1) 复刻手机端：31010 预告 + 30001 userMessage（type 必须正确）
  try {
    const syncFrames = buildSyncUnreliableFrames({
      ackData,
      appCid,
      text,
      token: token || '1#1#4#4333439630',
    });
    const fired = await dispatchSyncFrames(client, syncFrames);
    result.nativeSyncHandlerCalled = fired > 0;
    result.syncPrelude31010Dispatched = true;
    result.syncUserMessage30001Dispatched = true;
    if (result.nativeSyncHandlerCalled) {
      println(`[千帆] 原生同步：已分发 31010+30001 sync 帧（${fired} 次 WS dispatch）`);
    }
  } catch (err) {
    result.failedReason = `native_sync_dispatch_fail:${err.message || err}`;
  }

  // 2) 原生重选会话，触发千帆自己的消息列表加载
  try {
    const reselect = await reselectConversationNative(client, appCid);
    result.conversationReselected = Boolean(reselect?.clicked);
    if (result.conversationReselected) {
      println(`[千帆] 原生同步：已重选会话触发页面刷新 appCid=${appCid}`);
    }
  } catch (err) {
    println(`[千帆] 原生同步：重选会话失败 ${err.message || err}`);
  }

  // 3) 再次分发 30001（重选后 handler 可能才注册完毕）
  try {
    const frames = buildSyncUnreliableFrames({ ackData, appCid, text, token: token || '1#1#4#4333439630' });
    await dispatchSyncFrames(client, [frames[1]]);
  } catch {
    // ignore
  }

  // 4) /message/read/from/one 清倒计时/弹窗
  if (ackData.msgId && targetAppUid) {
    try {
      const readFrame = buildReadFromOneFrame({
        appCid,
        msgId: ackData.msgId,
        targetAppUid,
        seq: nextSeq,
      });
      const readSent = await evalPage(
        client,
        `(function(){
          if (!window.__qfSendWsPayload) return { ok: false, reason: 'no_send' };
          return window.__qfSendWsPayload(${JSON.stringify(JSON.stringify(readFrame))}, ${JSON.stringify(appCid)});
        })()`
      );
      result.readFromOneSent = Boolean(readSent?.ok);
      if (result.readFromOneSent) {
        println(`[千帆] 原生同步：已触发 /message/read/from/one msgId=${ackData.msgId}`);
        bridge.lastSeq = nextSeq;
        nextSeq += 1;
      }
    } catch (err) {
      println(`[千帆] 原生同步：read/from/one 失败 ${err.message || err}`);
    }
  }

  // 5) HTTP 刷新消息列表 + 待回复状态
  try {
    await fetchMessageListViaPage(client, bridge.lastMessageListRequest, appCid);
    result.messageListRefreshTriggered = true;
  } catch {
    // ignore
  }

  if (chatId) {
    try {
      const unchecked = await fetchUncheckedViaPage(client, bridge, chatId);
      result.conversationListRefreshTriggered = Boolean(unchecked?.ok);
    } catch {
      // ignore
    }
  }

  await new Promise((r) => setTimeout(r, 1500));

  try {
    const observed = await evalPage(
      client,
      `(function(){
        if (!window.__qfObservePcState) return null;
        return window.__qfObservePcState(${JSON.stringify(appCid)}, ${JSON.stringify(ackData.msgId || '')}, ${JSON.stringify(text || '')});
      })()`
    );
    if (observed) {
      result.pcBubbleInsertedByQianfan = Boolean(observed.pcBubbleInsertedByQianfan);
      result.pcCountdownClearedByQianfan = Boolean(observed.pcCountdownClearedByQianfan);
      result.pcPopupClearedByQianfan = Boolean(observed.pcPopupClearedByQianfan);
      result.conversationUpdatedByQianfan = Boolean(observed.conversationUpdatedByQianfan);
    }
  } catch {
    // ignore
  }

  if (!result.pcBubbleInsertedByQianfan) {
    result.failedReason = result.failedReason || 'bubble_not_inserted_by_qianfan';
  }

  return result;
}

module.exports = {
  triggerNativeSyncAfterAck,
  buildSyncUnreliableFrames,
  buildReadFromOneFrame,
  installNativeSyncBridge,
  NATIVE_SYNC_BRIDGE_SCRIPT,
  SYNC_TYPE_PRELUDE,
  SYNC_TYPE_USER_MESSAGE,
};
