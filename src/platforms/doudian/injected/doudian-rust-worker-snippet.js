/**
 * 生成注入到 electron/rust_im_worker_index.js 的运行时代码（Node/worker 端字符串）
 */
function buildRustWorkerInjectedCode(options = {}) {
  const port = Number(options.bridgePort || 19527);
  const wsUrl = `ws://127.0.0.1:${port}/doudian/bridge`;

  return `
;(function () {
  try {
    var g = typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : this);
    if (!g || g.__DOUDIAN_RUST_WORKER_PATCH__) return;
    g.__DOUDIAN_RUST_WORKER_PATCH__ = true;

    var BRIDGE_URL = ${JSON.stringify(wsUrl)};
    var bridgeId = 'rust-worker-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    var ws = null;
    var reconnectTimer = null;

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

    function sanitizeUrl(url) {
      try {
        var u = new URL(url);
        return u.origin + u.pathname;
      } catch (e) {
        return safeString(url).split('?')[0].slice(0, 120);
      }
    }

    function resolveApiName(url) {
      var u = safeString(url).toLowerCase();
      if (u.indexOf('currentuser') >= 0) return 'currentuser';
      if (u.indexOf('get_current_conversation_list') >= 0) return 'get_current_conversation_list';
      if (u.indexOf('get_link_info') >= 0) return 'get_link_info';
      if (u.indexOf('conversation') >= 0) return 'conversation';
      if (u.indexOf('message') >= 0) return 'message';
      return 'unknown';
    }

    var SKIP_KEYS = /cookie|token|csrf|authorization|ticket|sign|x-ms-token|bd-ticket|session-sign/i;
    var FIELD_KEYS = {
      shopId: 1, shop_id: 1, shopName: 1, shop_name: 1, accountId: 1, account_id: 1,
      conversationId: 1, conversation_id: 1, conversation_short_id: 1,
      buyerId: 1, buyer_id: 1, userId: 1, user_id: 1,
      buyerName: 1, nickName: 1, nickname: 1, name: 1,
      messageId: 1, message_id: 1, serverMessageId: 1,
      content: 1, text: 1, msg: 1, message: 1,
      sendTime: 1, createTime: 1, timestamp: 1, unread: 1, unreadCount: 1
    };

    function shallowExtract(obj, depth, counter, bag) {
      if (!obj || depth > 6 || counter.n > 3000) return;
      counter.n++;
      if (Array.isArray(obj)) {
        for (var i = 0; i < obj.length && i < 50; i++) shallowExtract(obj[i], depth + 1, counter, bag);
        return;
      }
      if (typeof obj !== 'object') return;
      for (var key in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
        if (SKIP_KEYS.test(key)) continue;
        var val = obj[key];
        if (FIELD_KEYS[key] || FIELD_KEYS[key.toLowerCase()]) {
          if (typeof val === 'string' || typeof val === 'number') bag[key] = safeString(val).slice(0, 1000);
        }
        if (val && typeof val === 'object') shallowExtract(val, depth + 1, counter, bag);
      }
    }

    function extractItems(payload) {
      var conversations = [];
      var messages = [];
      var counter = { n: 0 };
      function walk(obj, depth) {
        if (!obj || depth > 6 || counter.n > 3000) return;
        counter.n++;
        if (Array.isArray(obj)) {
          for (var i = 0; i < obj.length && i < 100; i++) {
            var item = obj[i];
            if (item && typeof item === 'object') {
              var convId = pickFirst(item.conversationId, item.conversation_id, item.conversation_short_id);
              var buyerId = pickFirst(item.buyerId, item.buyer_id, item.userId, item.user_id);
              var buyerName = pickFirst(item.buyerName, item.nickName, item.nickname, item.name);
              var text = pickFirst(item.content, item.text, item.msg, item.message);
              if (convId || buyerId || buyerName) {
                conversations.push({ conversationId: convId, buyerId: buyerId, buyerName: buyerName, text: safeString(text).slice(0, 200) });
              }
              if (text && text.length >= 4) {
                messages.push({ messageId: pickFirst(item.messageId, item.message_id, item.serverMessageId), text: safeString(text).slice(0, 200) });
              }
            }
            walk(item, depth + 1);
          }
          return;
        }
        if (typeof obj === 'object') {
          for (var k in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
            if (SKIP_KEYS.test(k)) continue;
            walk(obj[k], depth + 1);
          }
        }
      }
      walk(payload, 0);
      return { conversations: conversations.slice(0, 50), messages: messages.slice(0, 50) };
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

    function emitNetworkCandidate(url, body, sourceType) {
      var urlStr = safeString(url);
      if (!/pigeon\\.jinritemai\\.com|currentuser|get_current_conversation_list|get_link_info|conversation|message/i.test(urlStr)) return;
      var apiName = resolveApiName(urlStr);
      var shopInfo = {};
      var conversationCount = 0;
      var messageCount = 0;
      var items = [];
      try {
        var json = JSON.parse(body);
        var bag = {};
        shallowExtract(json, 0, { n: 0 }, bag);
        shopInfo = {
          shopId: pickFirst(bag.shopId, bag.shop_id),
          shopName: pickFirst(bag.shopName, bag.shop_name),
          accountId: pickFirst(bag.accountId, bag.account_id),
        };
        var extracted = extractItems(json);
        conversationCount = extracted.conversations.length;
        messageCount = extracted.messages.length;
        items = extracted.conversations.slice(0, 10);
      } catch (e) {}
      send('doudian.worker.network_candidate', {
        bridgeType: 'rust_worker',
        source: sourceType,
        url: sanitizeUrl(urlStr),
        apiName: apiName,
        shopInfo: shopInfo,
        conversationCount: conversationCount,
        messageCount: messageCount,
        items: items,
      });
    }

    function installNetworkHooks() {
      try {
        var origFetch = g.fetch;
        if (origFetch && !origFetch.__doudianHook) {
          var wrappedFetch = function () {
            var reqUrl = arguments[0] && arguments[0].url ? arguments[0].url : arguments[0];
            return origFetch.apply(this, arguments).then(function (resp) {
              try {
                var respUrl = safeString(resp.url || reqUrl);
                if (/pigeon\\.jinritemai\\.com|currentuser|get_current_conversation_list|get_link_info|conversation|message/i.test(respUrl)) {
                  resp.clone().text().then(function (body) {
                    emitNetworkCandidate(respUrl, body, 'fetch');
                  }).catch(function () {});
                }
              } catch (e) {}
              return resp;
            });
          };
          wrappedFetch.__doudianHook = true;
          g.fetch = wrappedFetch;
        }
      } catch (e) {}
      try {
        if (typeof XMLHttpRequest !== 'undefined') {
          var XO = XMLHttpRequest.prototype.open;
          var XS = XMLHttpRequest.prototype.send;
          if (!XO.__doudianHook) {
            XMLHttpRequest.prototype.open = function (method, url) {
              this.__doudianUrl = url;
              return XO.apply(this, arguments);
            };
            XMLHttpRequest.prototype.send = function () {
              var xhr = this;
              var reqUrl = safeString(xhr.__doudianUrl);
              xhr.addEventListener('load', function () {
                try {
                  if (/pigeon\\.jinritemai\\.com|currentuser|get_current_conversation_list|get_link_info|conversation|message/i.test(reqUrl)) {
                    emitNetworkCandidate(reqUrl, safeString(xhr.responseText), 'xhr');
                  }
                } catch (e) {}
              });
              return XS.apply(this, arguments);
            };
            XO.__doudianHook = true;
          }
        }
      } catch (e) {}
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
        if (typeof WebSocket === 'undefined') return;
        if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
        ws = new WebSocket(BRIDGE_URL);
        ws.onopen = function () {
          try {
            installNetworkHooks();
            send('bridge.hello', { bridgeType: 'rust_worker', patchMarker: '__DOUDIAN_BRIDGE_PATCH__' });
            send('bridge.ready', { bridgeType: 'rust_worker' });
          } catch (e) {
            scheduleReconnect();
          }
        };
        ws.onerror = function () { scheduleReconnect(); };
        ws.onclose = function () { scheduleReconnect(); };
      } catch (e) {
        scheduleReconnect();
      }
    }

    try { console.log('[抖店桥] rust worker patch loaded'); } catch (e) {}
    installNetworkHooks();
    connect();
  } catch (e) {}
})();
`;
}

function buildRustWorkerPatchSnippet(bridgePort) {
  const { PATCH_MARKER } = require('../doudian-asar-patch-constants');
  return `\n;/* ${PATCH_MARKER} rust_worker */\n${buildRustWorkerInjectedCode({ bridgePort })}`;
}

module.exports = {
  buildRustWorkerInjectedCode,
  buildRustWorkerPatchSnippet,
};
