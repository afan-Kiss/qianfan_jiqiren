/**
 * 千帆 PC 客服台页面 UI 同步（会话点击 / 本地回显）
 */
const { println } = require('./utils');
const { cdpRuntimeEvaluate, cdpAddScriptToEvaluateOnNewDocument } = require('./cdp-timeout');

const PAGE_BRIDGE_SCRIPT = `(function(){
  if (window.__qfPageBridgeInstalled) return { ok: true, already: true };
  window.__qfPageBridgeInstalled = true;

  function findMessageListContainer() {
    var selectors = [
      '[class*="message-list"]',
      '[class*="msg-list"]',
      '[class*="chat-content"]',
      '[class*="chat-main"]',
      '[class*="im-chat"]',
      '[class*="conversation-detail"]',
      '[class*="message-container"]',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function clickConversationByAppCid(appCid) {
    if (!appCid) return false;
    var attrSelectors = [
      '[data-app-cid="' + appCid + '"]',
      '[data-appcid="' + appCid + '"]',
      '[data-cid="' + appCid + '"]',
    ];
    for (var i = 0; i < attrSelectors.length; i++) {
      var hit = document.querySelector(attrSelectors[i]);
      if (hit) {
        hit.click();
        return true;
      }
    }
    var nodes = document.querySelectorAll('[data-app-cid],[data-appcid],[data-cid]');
    for (var j = 0; j < nodes.length; j++) {
      var el = nodes[j];
      var v = el.getAttribute('data-app-cid') || el.getAttribute('data-appcid') || el.getAttribute('data-cid');
      if (v === appCid) {
        el.click();
        return true;
      }
    }
    return false;
  }

  function injectLocalEcho(appCid, text, msgId) {
    var root = findMessageListContainer();
    if (!root || !text) return false;
    var old = root.querySelector('[data-qf-local-echo="' + (msgId || text) + '"]');
    if (old) return true;
    var item = document.createElement('div');
    item.setAttribute('data-qf-local-echo', String(msgId || text));
    item.setAttribute('data-msg-id', msgId || '');
    item.setAttribute('data-app-cid', appCid || '');
    item.style.cssText = 'padding:8px 12px;margin:8px 0 8px auto;background:#e8f4ff;border-radius:8px;font-size:14px;max-width:75%;word-break:break-word;color:#333;';
    item.textContent = text;
    root.appendChild(item);
    try { root.scrollTop = root.scrollHeight; } catch (e) {}
    return true;
  }

  window.__qfPageBridge = {
    clickConversation: clickConversationByAppCid,
    injectLocalEcho: injectLocalEcho,
    refreshConversation: function(appCid, opts) {
      opts = opts || {};
      var clicked = clickConversationByAppCid(appCid);
      var echoed = false;
      if (opts.text) {
        echoed = injectLocalEcho(appCid, opts.text, opts.msgId || '');
      }
      return { clicked: clicked, echoed: echoed, ok: clicked || echoed };
    },
  };

  window.addEventListener('qf-sync-messages', function(ev) {
    var cid = ev && ev.detail && ev.detail.appCid;
    if (!cid || !window.__qfPageBridge) return;
    window.__qfPageBridge.clickConversation(cid);
  });

  return { ok: true };
})()`;

async function installQfPageBridge(client) {
  if (!client?.Runtime) return false;
  const { Page, Runtime } = client;
  try {
    await cdpAddScriptToEvaluateOnNewDocument(Page, PAGE_BRIDGE_SCRIPT);
  } catch {
    // ignore
  }
  const result = await cdpRuntimeEvaluate(Runtime, {
    expression: PAGE_BRIDGE_SCRIPT,
    returnByValue: true,
  });
  return Boolean(result?.result?.value?.ok);
}

async function applyPcConversationSync(client, { appCid, msgId, text }) {
  if (!client?.Runtime) return { ok: false, reason: 'no_runtime' };

  const payload = JSON.stringify({
    appCid: String(appCid || ''),
    msgId: String(msgId || ''),
    text: String(text || ''),
  });

  const result = await cdpRuntimeEvaluate(client.Runtime, {
    expression: `(function(){
      var opts = ${payload};
      var bridge = window.__qfPageBridge;
      if (!bridge) return { ok: false, reason: 'no_bridge' };
      return bridge.refreshConversation(opts.appCid, { text: opts.text, msgId: opts.msgId });
    })()`,
    returnByValue: true,
  });

  const value = result?.result?.value || { ok: false, reason: 'eval_fail' };
  if (value.clicked) {
    println(`[千帆] PC 页面：已触发会话重新选中 appCid=${appCid}`);
  }
  if (value.echoed) {
    println(`[千帆] PC 页面：已插入本地回显 msgId=${msgId || 'n/a'}`);
  }
  return value;
}

module.exports = {
  installQfPageBridge,
  applyPcConversationSync,
  PAGE_BRIDGE_SCRIPT,
};
