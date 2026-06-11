const {
  PATCH_MARKER,
  PRELOAD_TEST_FLAG,
  BRIDGE_PATCH_FLAG,
  IM_WORKSPACE_URL,
  WORKSPACE_URL_PATTERN,
} = require('./doudian-asar-patch-constants');
const { buildInjectedRuntimeCode } = require('./injected/doudian-shop-identity-snippet');
const {
  buildUiNoiseFilterBrowserCode,
  buildMemoryCacheHookBrowserCode,
} = require('./injected/doudian-ipc-memory-cache-snippet');

function buildMinimalPatchSnippet(bridgePort) {
  const port = Number(bridgePort || 19527);
  const wsUrl = `ws://127.0.0.1:${port}/doudian/bridge`;
  const injected = buildInjectedRuntimeCode({ bridgePort: port });

  return `
;/* ${PATCH_MARKER} */
;(function () {
  try {
    if (window.${BRIDGE_PATCH_FLAG}) return;
    window.${BRIDGE_PATCH_FLAG} = true;
    window.${PRELOAD_TEST_FLAG} = true;

    var BRIDGE_URL = ${JSON.stringify(wsUrl)};
    var IM_URL = ${JSON.stringify(IM_WORKSPACE_URL)};
    var IM_PATH = ${JSON.stringify(WORKSPACE_URL_PATTERN)};
    var bridgeId = 'doudian-patch-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    var ws = null;
    var reconnectTimer = null;
    var heartbeatTimer = null;

    function safeString(v) {
      try { return String(v || ''); } catch (e) { return ''; }
    }

    function pickFirst() {
      for (var i = 0; i < arguments.length; i++) {
        var s = safeString(arguments[i]).trim();
        if (s) return s;
      }
      return '';
    }

    function maskValue(v) {
      var s = safeString(v).trim();
      if (!s) return '';
      if (/^1\\d{10}$/.test(s)) return s.slice(0, 3) + '****' + s.slice(-4);
      if (s.indexOf('@') >= 0) {
        var parts = s.split('@');
        return (parts[0].length <= 2 ? '*' : parts[0].slice(0, 2) + '***') + '@' + parts[1];
      }
      if (s.length <= 4) return '****';
      return s.slice(0, 2) + '***' + s.slice(-2);
    }

    function hashText(text) {
      var s = safeString(text);
      var h = 0;
      for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      return safeString(h);
    }

    function send(type, payload) {
      try {
        if (!ws || ws.readyState !== 1) return;
        ws.send(JSON.stringify({
          platform: 'doudian',
          type: type,
          bridgeId: bridgeId,
          timestamp: Date.now(),
          payload: payload || {},
        }));
      } catch (e) {}
    }

    function isImHref(href) {
      return safeString(href).indexOf(IM_PATH) >= 0;
    }

    ${buildUiNoiseFilterBrowserCode()}
    ${buildMemoryCacheHookBrowserCode()}
    ${injected}

    function getPageInfo() {
      var href = safeString(typeof location !== 'undefined' && location ? location.href : '');
      var shop = getShopInfo();
      var bodyLen = 0;
      var chatListExists = false;
      var inputExists = false;
      try {
        bodyLen = safeString(document && document.body && document.body.innerText).length;
        chatListExists = !!(document && document.querySelector('[class*="conversation"], [class*="session-list"], [class*="chat-list"], [class*="message-list"], #chatListScrollArea'));
        inputExists = !!(document && document.querySelector('textarea, [contenteditable="true"], input[type="text"]'));
      } catch (e) {}
      return {
        href: href,
        origin: safeString(typeof location !== 'undefined' && location ? location.origin : ''),
        pathname: safeString(typeof location !== 'undefined' && location ? location.pathname : ''),
        title: safeString(typeof document !== 'undefined' && document ? document.title : ''),
        readyState: safeString(typeof document !== 'undefined' && document ? document.readyState : ''),
        visibilityState: safeString(typeof document !== 'undefined' && document ? document.visibilityState : ''),
        hasFocus: !!(typeof document !== 'undefined' && document && document.hasFocus && document.hasFocus()),
        userAgent: safeString(typeof navigator !== 'undefined' && navigator ? navigator.userAgent : ''),
        isImWorkspace: isImHref(href),
        chatListExists: chatListExists,
        inputExists: inputExists,
        bodyTextLength: bodyLen,
        shopId: shop.shopId,
        shopName: shop.shopName,
        accountId: maskValue(shop.accountId),
        sessionPartitionKey: shop.sessionPartitionKey,
        persistAccountId: pickFirst(
          shop.persistAccountId,
          safeString(shop.sessionPartitionKey).indexOf('persist:') === 0
            ? safeString(shop.sessionPartitionKey).replace(/^persist:/, '')
            : ''
        ),
        loginDomainType: shop.loginDomainType,
        activeShopNameFromDom: shop.activeShopNameFromDom,
        activeShopIdFromDom: shop.activeShopIdFromDom,
        shopIdentitySource: shop.shopIdentitySource,
        patchMarker: ${JSON.stringify(PATCH_MARKER)},
        preloadTest: true,
      };
    }

    function emitShopDetected() {
      var info = getPageInfo();
      send('doudian.shop.detected', {
        shopId: info.shopId,
        shopName: info.shopName,
        accountId: info.accountId,
        sessionPartitionKey: info.sessionPartitionKey,
        shopIdentitySource: info.shopIdentitySource,
        activeShopNameFromDom: info.activeShopNameFromDom,
        activeShopIdFromDom: info.activeShopIdFromDom,
        href: info.href,
        title: info.title,
      });
    }

    function stopMessageObserver() {
      observerStarted = false;
      try { if (domObserver) domObserver.disconnect(); } catch (e) {}
      domObserver = null;
      send('bridge.log', { command: 'debug.stop_message_observer', success: true });
    }

    function emitOpenImAttempt(payload) {
      send('bridge.open_im_attempt', payload || {});
    }

    function handleDebugOpenIm() {
      var info = getPageInfo();
      if (info.isImWorkspace) {
        emitOpenImAttempt({
          method: 'skip',
          ok: true,
          href: info.href || '',
          error: '',
          reason: 'already_on_im_page',
        });
        return;
      }

      emitOpenImAttempt({
        method: 'command_received',
        ok: true,
        href: info.href || '',
        error: '',
      });

      var method = 'window.open';
      var ok = false;
      var error = '';
      try {
        var opened = window.open(IM_URL, '_blank');
        if (opened) {
          ok = true;
        } else {
          method = 'location.href';
          window.location.href = IM_URL;
          ok = true;
        }
      } catch (e1) {
        error = safeString(e1 && (e1.message || e1));
        try {
          method = 'location.href';
          window.location.href = IM_URL;
          ok = true;
          error = '';
        } catch (e2) {
          method = method || 'window.open';
          error = safeString(e2 && (e2.message || e2));
          ok = false;
        }
      }
      emitOpenImAttempt({
        method: method,
        ok: ok,
        href: info.href || '',
        error: error,
      });
    }

    function handleIncomingCommand(raw) {
      var cmd = null;
      try { cmd = JSON.parse(raw); } catch (e) { return; }
      var type = safeString(cmd && cmd.type);
      if (type === 'debug.ping') {
        send('bridge.pong', { ok: true, at: Date.now(), info: getPageInfo() });
        return;
      }
      if (type === 'debug.get_page_info' || type === 'debug.get_shop_info') {
        var pageInfo = getPageInfo();
        send('bridge.log', { command: type, info: pageInfo });
        emitShopDetected();
        return;
      }
      if (type === 'debug.get_dom_snapshot') {
        runImDomDiagnostic();
        scanDomCandidatesDiagnostic();
        return;
      }
      if (type === 'debug.start_message_observer') startMessageObserver();
      else if (type === 'debug.stop_message_observer') stopMessageObserver();
      else if (type === 'debug.open_im_workspace') handleDebugOpenIm();
      else if (type === 'debug.read_current_chat_history') readCurrentChatHistory();
      else if (type === 'debug.inspect_chat_dom') inspectChatDom();
      else if (type === 'debug.get_conversation_hints') getConversationHints();
      else if (type === 'debug.inspect_reply_editor') inspectReplyEditor();
      else if (type === 'debug.fill_reply_draft') fillReplyDraft(cmd.payload || {});
      else if (type === 'debug.send_message_to_buyer') sendMessageToBuyer(cmd.payload || {});
      else if (type === 'debug.send_to_current_conversation') sendMessageToBuyer(cmd.payload || {});
      else if (type === 'debug.list_current_conversations') {
        if (typeof inspectConversationSources === 'function') {
          inspectConversationSources({ emitListCaptured: true });
        } else {
          listCurrentConversations();
        }
      }
      else if (type === 'debug.inspect_conversation_sources') inspectConversationSources({});
    }

    function scheduleReconnect() {
      try {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(function () {
          reconnectTimer = null;
          connect();
        }, 3000);
      } catch (e) {}
    }

    function connect() {
      try {
        if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
        ws = new WebSocket(BRIDGE_URL);
        ws.onopen = function () {
          try {
            maybeInstallEarlyNetworkHook();
            var info = getPageInfo();
            send('bridge.hello', info);
            send('bridge.ready', info);
            emitShopDetected();
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(function () {
              send('bridge.heartbeat', getPageInfo());
            }, 5000);
          } catch (e) {
            scheduleReconnect();
          }
        };
        ws.onmessage = function (event) {
          try { handleIncomingCommand(safeString(event && event.data)); } catch (e) {}
        };
        ws.onerror = function () { scheduleReconnect(); };
        ws.onclose = function () {
          try {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            scheduleReconnect();
          } catch (e) {}
        };
      } catch (e) {
        scheduleReconnect();
      }
    }

    try { console.log('[抖店桥] preload patch loaded'); } catch (e) {}
    installIpcMemoryCacheHook();
    installNetworkHooks(true);
    maybeInstallEarlyNetworkHook();
    connect();

    if (typeof document !== 'undefined' && document) {
      var onDom = function () {
        maybeInstallEarlyNetworkHook();
        send('bridge.dom_ready', getPageInfo());
        emitShopDetected();
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onDom);
      else onDom();
    }

    if (typeof window !== 'undefined' && window) {
      window.addEventListener('load', function () {
        maybeInstallEarlyNetworkHook();
        send('bridge.window_load', getPageInfo());
        emitShopDetected();
      });
    }
  } catch (e) {}
})();
`;
}

function expectedWsUrl(bridgePort) {
  return `ws://127.0.0.1:${Number(bridgePort || 19527)}/doudian/bridge`;
}

module.exports = {
  buildMinimalPatchSnippet,
  expectedWsUrl,
};
