/**
 * 千帆 PC 客服台 UI 同步（CDP，不整页刷新）
 */
const { extractMessagesFromResponse } = require('./chat-parse');
const { println } = require('./utils');
const { assertSendAllowedForBuyer } = require('./qianfan-send-guard');
const {
  cdpRuntimeEvaluate,
  cdpAddScriptToEvaluateOnNewDocument,
  cdpPageEnable,
  CDP_EVAL_DEFAULT_MS,
} = require('./cdp-timeout');

const UI_SYNC_BRIDGE_SCRIPT = `(function(){
  if (window.__qfUiSyncInstalled && window.__qfUiSync && window.__qfUiSync.sendTextMessage) {
    return { ok: true, already: true };
  }
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

  function normText(s) {
    return String(s || '').replace(/\\s+/g, ' ').trim();
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

  function findConversationByBuyerNick(buyerNick) {
    var nick = normText(buyerNick);
    if (!nick) return null;
    var items = document.querySelectorAll('.chat-item, [class*="chat-item"]');
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var t = normText(el.textContent);
      if (!t) continue;
      if (t.indexOf(nick) === 0) return el;
    }
    return null;
  }

  function findConversationTarget(appCid, buyerNick) {
    return findConversationByAppCid(appCid) || findConversationByBuyerNick(buyerNick) || null;
  }

  function findAnotherConversation(appCid, buyerNick) {
    var list = findConversationNodes();
    for (var i = 0; i < list.length; i++) {
      if (list[i].appCid && list[i].appCid !== appCid) return list[i].el;
    }
    var nick = normText(buyerNick);
    var items = document.querySelectorAll('.chat-item, [class*="chat-item"]');
    for (var j = 0; j < items.length; j++) {
      var el = items[j];
      var t = normText(el.textContent);
      if (!t) continue;
      if (nick && t.indexOf(nick) === 0) continue;
      return el;
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
    reselectConversation: async function(appCid, buyerNick) {
      var target = findConversationTarget(appCid, buyerNick);
      if (!target) return { clicked: false, reason: 'row_not_found', appCid: appCid || '', buyerNick: buyerNick || '' };
      var other = findAnotherConversation(appCid, buyerNick);
      if (other) {
        safeClick(other);
        await sleep(280);
      }
      safeClick(target);
      await sleep(320);
      tryDispatchStoreRefresh(appCid);
      return { clicked: true, reselected: !!other, preview: normText(target.textContent).slice(0, 60) };
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
    findChatInput: function() {
      var ta = document.querySelector('#jarvis-reply-textarea, textarea.reply-textarea');
      if (ta && ta.offsetParent !== null) return ta;
      var selectors = [
        'textarea[placeholder*="Enter"]',
        'textarea[placeholder*="发送"]',
        'textarea[placeholder*="消息"]',
        '[contenteditable="true"][role="textbox"]',
      ];
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (el && el.offsetParent !== null) return el;
      }
      return null;
    },
    findSendButton: function() {
      var btn = Array.from(document.querySelectorAll('button')).find(function(b) {
        return normText(b.textContent) === '发送';
      });
      if (btn) return btn;
      return document.querySelector('button.d-button.--color-primary, button[class*="send"]');
    },
    setInputText: function(el, text) {
      var val = String(text || '');
      if (!el || !val) return false;
      el.focus();
      el.click();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        var setter = Object.getOwnPropertyDescriptor(
          el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          'value'
        );
        setter = setter && setter.set;
        if (setter) setter.call(el, val);
        else el.value = val;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: val }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      if (el.isContentEditable) {
        el.textContent = val;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: val }));
        return true;
      }
      return false;
    },
    pressEnter: function(el) {
      if (!el) return;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    },
    sendTextMessage: async function(appCid, text, buyerNick) {
      var msg = String(text || '').trim();
      if (!msg) return { ok: false, reason: 'empty_text' };
      var pick = await window.__qfUiSync.reselectConversation(appCid, buyerNick);
      await sleep(450);
      var input = window.__qfUiSync.findChatInput();
      if (!input) return { ok: false, reason: 'input_not_found', clicked: pick.clicked, pick: pick };
      if (!window.__qfUiSync.setInputText(input, msg)) {
        return { ok: false, reason: 'input_set_failed', clicked: pick.clicked };
      }
      await sleep(200);
      var btn = window.__qfUiSync.findSendButton();
      var btnDisabled = btn ? !!btn.disabled : null;
      if (btn && !btn.disabled) {
        safeClick(btn);
      } else if (btn && btn.disabled) {
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: msg }));
        await sleep(150);
        if (!btn.disabled) safeClick(btn);
        else window.__qfUiSync.pressEnter(input);
      } else {
        window.__qfUiSync.pressEnter(input);
      }
      await sleep(700);
      if (window.__qfRehookImpaasSockets) window.__qfRehookImpaasSockets();
      var domVerified = window.__qfUiSync.hasRealMessageInDom(appCid, '', msg);
      return {
        ok: domVerified || pick.clicked,
        method: btn && !btnDisabled ? 'ui_button' : 'ui_enter',
        clicked: pick.clicked,
        domVerified: domVerified,
        inputId: input.id || '',
        pickPreview: pick.preview || '',
        sendDisabled: btnDisabled,
      };
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
    if (Array.isArray(obj.appCids)) obj.appCids = [cid];
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

  const ok = apiConfirmed || visibleInDom || reselected;
  if (ok) {
    println('[千帆] PC 同步：成功（仅观测/刷新，不插入假气泡）');
  } else {
    println('[千帆] PC 同步：未确认，请使用 qianfan-native-sync 触发原生链');
  }

  return { ok, apiConfirmed, reselected, localEcho: false, visibleInDom, directDomMutationUsed: false };
}

/**
 * UI 输入框发送（CDP）。仅用于 WS 探针唤醒（饭饭 + 亲亲）或测试脚本。
 * 不得作为对客户/买家的回复投递路径。
 */
async function sendBuyerTextViaUi(client, { appCid, text, buyerNick }) {
  if (!client?.Runtime) return { ok: false, reason: 'no_runtime' };
  const cid = String(appCid || '').trim();
  const msg = String(text || '').trim();
  const nick = String(buyerNick || '').trim();
  if (!msg) return { ok: false, reason: 'missing_text' };
  if (!cid && !nick) return { ok: false, reason: 'missing_target' };
  assertSendAllowedForBuyer(nick, 'sendBuyerTextViaUi');

  try {
    if (client.Page) {
      await cdpPageEnable(client.Page);
      await client.Page.bringToFront();
      println(`[千帆发送] 已将千帆页面置前台 shop=${nick || cid}`);
    }
  } catch (err) {
    println(`[千帆发送] bringToFront 失败：${err.message || err}`);
  }

  await installUiSyncBridge(client);
  const result = await cdpRuntimeEvaluate(
    client.Runtime,
    {
      expression: `(async function(){
        var sync = window.__qfUiSync;
        if (!sync || !sync.sendTextMessage) return { ok: false, reason: 'no_ui_sync' };
        return await sync.sendTextMessage(${JSON.stringify(cid)}, ${JSON.stringify(msg)}, ${JSON.stringify(nick)});
      })()`,
      awaitPromise: true,
      returnByValue: true,
    },
    25000
  );
  const value = result?.result?.value || { ok: false, reason: 'eval_fail' };
  if (value.ok) {
    println(
      `[千帆发送] UI 输入框已发送 appCid=${cid} method=${value.method || 'ui'} domVerified=${Boolean(value.domVerified)}`
    );
  }
  return value;
}

module.exports = {
  syncQianfanConversationUi,
  installUiSyncBridge,
  patchMessageListBody,
  sendBuyerTextViaUi,
};
