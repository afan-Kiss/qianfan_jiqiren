/**
 * 千帆 PC 客服台 UI 同步（CDP，不整页刷新）
 */
const { extractMessagesFromResponse } = require('./chat-parse');
const { println } = require('./utils');
const {
  cdpRuntimeEvaluate,
  cdpAddScriptToEvaluateOnNewDocument,
  CDP_EVAL_DEFAULT_MS,
} = require('./cdp-timeout');

const UI_SYNC_BRIDGE_SCRIPT = `(function(){
  if (window.__qfUiSyncInstalled) return { ok: true, already: true };
  window.__qfUiSyncInstalled = true;

  function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  function findMessageListContainer() {
    var selectors = [
      '[class*="message-list"]',
      '[class*="msg-list"]',
      '[class*="chat-content"]',
      '[class*="chat-main"]',
      '[class*="im-chat"]',
      '[class*="conversation-detail"]',
      '[class*="message-container"]',
      '[class*="chat-body"]',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function getAppCidFromEl(el) {
    if (!el) return '';
    return (
      el.getAttribute('data-app-cid') ||
      el.getAttribute('data-appcid') ||
      el.getAttribute('data-cid') ||
      (el.dataset && (el.dataset.appCid || el.dataset.appcid || el.dataset.cid)) ||
      ''
    );
  }

  function findConversationNodes() {
    var nodes = document.querySelectorAll(
      '[data-app-cid],[data-appcid],[data-cid],li,div[class*="conv"],div[class*="session"],div[class*="chat-item"]'
    );
    var matched = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var cid = getAppCidFromEl(el);
      if (cid) matched.push({ el: el, appCid: cid });
    }
    return matched;
  }

  function findConversationByAppCid(appCid) {
    if (!appCid) return null;
    var list = findConversationNodes();
    for (var i = 0; i < list.length; i++) {
      if (list[i].appCid === appCid) return list[i].el;
    }
    var hit = document.querySelector('[data-app-cid="' + appCid + '"],[data-appcid="' + appCid + '"],[data-cid="' + appCid + '"]');
    return hit || null;
  }

  function findAnotherConversation(appCid) {
    var list = findConversationNodes();
    for (var i = 0; i < list.length; i++) {
      if (list[i].appCid && list[i].appCid !== appCid) return list[i].el;
    }
    return null;
  }

  function safeClick(el) {
    if (!el) return false;
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (e) {}
    try { el.click(); } catch (e2) {}
    return true;
  }

  function removeStaleLocalEcho(root, appCid, msgId, text) {
    if (!root) return;
    var nodes = root.querySelectorAll('[data-qf-bot-local-echo="true"]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var nid = node.getAttribute('data-qf-msg-id') || '';
      var body = String(node.textContent || '').trim();
      if ((msgId && nid === msgId) || (text && body === text)) {
        node.parentNode && node.parentNode.removeChild(node);
      }
    }
  }

  function hasRealMessageInDom(root, msgId, text) {
    if (!root) return false;
    if (msgId) {
      var byId = root.querySelector('[data-msg-id="' + msgId + '"],[data-message-id="' + msgId + '"]');
      if (byId && !byId.getAttribute('data-qf-bot-local-echo')) return true;
      if (root.innerHTML && root.innerHTML.indexOf(msgId) >= 0) return true;
    }
    if (text) {
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        var p = walker.currentNode.parentElement;
        if (p && p.getAttribute && p.getAttribute('data-qf-bot-local-echo') === 'true') continue;
        if (String(walker.currentNode.textContent || '').trim() === text) return true;
      }
    }
    return false;
  }

  function injectLocalEcho(appCid, text, msgId) {
    var root = findMessageListContainer();
    if (!root || !text) return false;
    removeStaleLocalEcho(root, appCid, msgId, text);
    if (hasRealMessageInDom(root, msgId, text)) return false;
    var marker = msgId || text;
    if (root.querySelector('[data-qf-bot-local-echo="true"][data-qf-msg-id="' + marker + '"]')) return true;

    var wrap = document.createElement('div');
    wrap.setAttribute('data-qf-bot-local-echo', 'true');
    wrap.setAttribute('data-qf-msg-id', msgId || '');
    wrap.setAttribute('data-app-cid', appCid || '');
    wrap.style.cssText = 'display:flex;justify-content:flex-end;margin:8px 12px;';
    var bubble = document.createElement('div');
    bubble.style.cssText =
      'padding:8px 12px;background:#3b82f6;color:#fff;border-radius:10px 10px 2px 10px;' +
      'font-size:14px;max-width:72%;word-break:break-word;line-height:1.4;box-shadow:0 1px 2px rgba(0,0,0,.08);';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    root.appendChild(wrap);
    try { root.scrollTop = root.scrollHeight; } catch (e) {}
    return true;
  }

  function tryDispatchStoreRefresh(appCid) {
    try {
      window.dispatchEvent(new CustomEvent('qf-sync-messages', { detail: { appCid: appCid } }));
    } catch (e) {}
    var tried = false;
    try {
      if (window.__STORE__ && typeof window.__STORE__.dispatch === 'function') {
        window.__STORE__.dispatch({ type: 'REFRESH_MESSAGES', appCid: appCid });
        tried = true;
      }
    } catch (e) {}
    return tried;
  }

  window.__qfUiSync = {
    fetchMessageList: async function(url, method, headers, body) {
      try {
        var res = await fetch(url, {
          method: method || 'POST',
          headers: headers || {},
          body: body || '{}',
          credentials: 'include',
        });
        var json = await res.json();
        return { ok: res.ok, status: res.status, body: json };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    },
    reselectConversation: async function(appCid) {
      var target = findConversationByAppCid(appCid);
      if (!target) return { clicked: false, reason: 'row_not_found' };
      var other = findAnotherConversation(appCid);
      if (other) {
        safeClick(other);
        await sleep(280);
      }
      safeClick(target);
      await sleep(320);
      tryDispatchStoreRefresh(appCid);
      return { clicked: true, reselected: !!other };
    },
    injectLocalEcho: injectLocalEcho,
    hasRealMessageInDom: function(appCid, msgId, text) {
      var root = findMessageListContainer();
      return hasRealMessageInDom(root, msgId, text);
    },
    cleanupLocalEcho: function(msgId, text) {
      var root = findMessageListContainer();
      removeStaleLocalEcho(root, '', msgId, text);
      return true;
    },
  };

  return { ok: true };
})()`;

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

async function installUiSyncBridge(client) {
  if (!client?.Runtime) return false;
  const { Page, Runtime } = client;
  try {
    await cdpAddScriptToEvaluateOnNewDocument(Page, UI_SYNC_BRIDGE_SCRIPT);
  } catch {
    // ignore
  }
  try {
    const result = await cdpRuntimeEvaluate(Runtime, {
      expression: UI_SYNC_BRIDGE_SCRIPT,
      returnByValue: true,
    });
    return Boolean(result?.result?.value?.ok);
  } catch {
    return false;
  }
}

function confirmMessageInApiBody(body, shopTitle, appCid, qianfanMsgId, text) {
  const messages = extractMessagesFromResponse(body, shopTitle, 'ui_sync');
  for (const msg of messages) {
    if (msg.appCid && msg.appCid !== appCid) continue;
    if (qianfanMsgId && msg.msgId === qianfanMsgId) return true;
    if (text && String(msg.text || '').trim() === String(text).trim() && msg.isSellerSide !== false) {
      const sender = String(msg.senderType || '').toUpperCase();
      if (!sender || sender !== 'CUSTOMER') return true;
    }
  }
  const raw = JSON.stringify(body || {});
  if (qianfanMsgId && raw.includes(qianfanMsgId) && raw.includes(appCid)) return true;
  return false;
}

/**
 * @param {{
 *   shopTitle: string,
 *   appCid: string,
 *   buyerNick?: string,
 *   qianfanMsgId?: string,
 *   text?: string,
 *   sentAt?: number,
 *   page?: object,
 *   cdpSession?: object,
 *   messageListTpl?: object,
 * }} ctx
 */
async function syncQianfanConversationUi(ctx) {
  const shopTitle = String(ctx?.shopTitle || '').trim();
  const appCid = String(ctx?.appCid || '').trim();
  const qianfanMsgId = String(ctx?.qianfanMsgId || '').trim();
  const text = String(ctx?.text || '').trim();
  const client = ctx?.cdpSession;

  if (!client?.Runtime) {
    println('[千帆] PC 同步：未找到店铺 CDP 会话');
    return { ok: false, apiConfirmed: false, reselected: false, localEcho: false };
  }

  println('[千帆] 正在同步 PC 客服台会话...');
  await installUiSyncBridge(client);

  const tpl = ctx?.messageListTpl || null;
  let apiConfirmed = false;

  if (tpl?.url && tpl?.headers) {
    const body = patchMessageListBody(tpl.bodyTemplate, appCid);
    try {
      const fetchResult = await cdpRuntimeEvaluate(
        client.Runtime,
        {
          expression: `(async function(){
            var sync = window.__qfUiSync;
            if (!sync) return { ok: false, reason: 'no_sync' };
            return await sync.fetchMessageList(
              ${JSON.stringify(tpl.url)},
              ${JSON.stringify(tpl.method || 'POST')},
              ${JSON.stringify(tpl.headers)},
              ${JSON.stringify(body)}
            );
          })()`,
          awaitPromise: true,
          returnByValue: true,
        },
        CDP_EVAL_DEFAULT_MS
      );
      const fetched = fetchResult?.result?.value;
      if (fetched?.ok && fetched.body) {
        apiConfirmed = confirmMessageInApiBody(fetched.body, shopTitle, appCid, qianfanMsgId, text);
        if (apiConfirmed) {
          println(`[千帆] PC 同步：已拉取最新聊天记录，包含本次回复 msgId=${qianfanMsgId || 'by_text'}`);
        }
      }
    } catch (err) {
      println(`[千帆] PC 同步：拉取消息列表失败 ${err.message || err}`);
    }
  }

  let reselected = false;
  try {
    const reselectResult = await cdpRuntimeEvaluate(
      client.Runtime,
      {
        expression: `(async function(){
          var sync = window.__qfUiSync;
          if (!sync) return { clicked: false, reason: 'no_sync' };
          return await sync.reselectConversation(${JSON.stringify(appCid)});
        })()`,
        awaitPromise: true,
        returnByValue: true,
      },
      CDP_EVAL_DEFAULT_MS
    );
    reselected = Boolean(reselectResult?.result?.value?.clicked);
    if (reselected) {
      println(`[千帆] PC 同步：已尝试重新选中当前会话 appCid=${appCid}`);
    }
  } catch (err) {
    println(`[千帆] PC 同步：重选会话失败 ${err.message || err}`);
  }

  let visibleInDom = false;
  try {
    const domCheck = await cdpRuntimeEvaluate(
      client.Runtime,
      {
        expression: `(function(){
          var sync = window.__qfUiSync;
          if (!sync) return false;
          return sync.hasRealMessageInDom(${JSON.stringify(appCid)}, ${JSON.stringify(qianfanMsgId)}, ${JSON.stringify(text)});
        })()`,
        returnByValue: true,
      },
      CDP_EVAL_DEFAULT_MS
    );
    visibleInDom = Boolean(domCheck?.result?.value);
  } catch {
    // ignore
  }

  let localEcho = false;
  if (!visibleInDom && text) {
    try {
      const echoResult = await cdpRuntimeEvaluate(
        client.Runtime,
        {
          expression: `(function(){
            var sync = window.__qfUiSync;
            if (!sync) return false;
            return sync.injectLocalEcho(${JSON.stringify(appCid)}, ${JSON.stringify(text)}, ${JSON.stringify(qianfanMsgId)});
          })()`,
          returnByValue: true,
        },
        CDP_EVAL_DEFAULT_MS
      );
      localEcho = Boolean(echoResult?.result?.value);
      if (localEcho) {
        println(`[千帆] PC 同步：已插入本地临时回显 msgId=${qianfanMsgId || 'n/a'}`);
      }
    } catch {
      // ignore
    }
  }

  if (apiConfirmed && (visibleInDom || localEcho)) {
    try {
      await cdpRuntimeEvaluate(
        client.Runtime,
        {
          expression: `(function(){
            var sync = window.__qfUiSync;
            if (sync) sync.cleanupLocalEcho(${JSON.stringify(qianfanMsgId)}, ${JSON.stringify(text)});
            return true;
          })()`,
          returnByValue: true,
        },
        CDP_EVAL_DEFAULT_MS
      );
    } catch {
      // ignore
    }
  }

  const ok = apiConfirmed || visibleInDom || reselected || localEcho;
  if (ok) {
    const mode = localEcho && !visibleInDom && !apiConfirmed ? '已插入本地临时回显' : '成功';
    println(`[千帆] PC 同步：${mode}`);
  } else {
    println('[千帆] PC 同步：未确认，客服台如未显示请稍后手动刷新当前会话');
  }

  return { ok, apiConfirmed, reselected, localEcho, visibleInDom };
}

module.exports = {
  syncQianfanConversationUi,
  installUiSyncBridge,
  patchMessageListBody,
};
