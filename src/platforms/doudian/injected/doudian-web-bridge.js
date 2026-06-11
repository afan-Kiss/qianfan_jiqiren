/**
 * 抖店页面注入桥 - 运行于抖店 Windows 客户端 Web 环境
 * 通过 CDP Runtime.evaluate 注入，不修改页面业务逻辑
 */
(function doudianWebBridgeBootstrap() {
  var existing = window.__DOUDIAN_BRIDGE__ || window.__DOUDIAN_BRIDGE;
  if (existing && existing.__installed) {
    return { ok: true, already: true, bridgeId: existing.bridgeId };
  }

  var PLATFORM = 'doudian';
  var bridgeId = 'dd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  var ws = null;
  var wsUrl = '';
  var heartbeatTimer = null;
  var reconnectTimer = null;
  var reconnectAttempt = 0;
  var config = {
    heartbeatIntervalMs: 30000,
    reconnectBaseMs: 2000,
    reconnectMaxMs: 30000,
    selectors: {},
    debugRawPayload: false,
  };

  var SENSITIVE_RE = /cookie|authorization|token|password|sessionid|手机号|身份证/i;

  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function redact(obj, depth) {
    depth = depth || 0;
    if (depth > 5 || obj == null) return obj;
    if (typeof obj === 'string') {
      return obj.length > 1500 ? obj.slice(0, 1500) + '...[truncated]' : obj;
    }
    if (Array.isArray(obj)) return obj.slice(0, 30).map(function (v) { return redact(v, depth + 1); });
    if (typeof obj !== 'object') return obj;
    var out = {};
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      if (SENSITIVE_RE.test(k)) { out[k] = '[redacted]'; continue; }
      out[k] = redact(obj[k], depth + 1);
    }
    return out;
  }

  function envelope(type, fields) {
    fields = fields || {};
    return {
      platform: PLATFORM,
      type: type,
      bridgeId: bridgeId,
      shopId: fields.shopId || '',
      shopName: fields.shopName || '',
      conversationId: fields.conversationId || '',
      buyerId: fields.buyerId || '',
      messageId: fields.messageId || '',
      timestamp: fields.timestamp || Date.now(),
      payload: fields.payload || {},
      raw: config.debugRawPayload ? redact(fields.raw || {}) : {},
    };
  }

  function emit(type, fields) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(envelope(type, fields)));
      return true;
    } catch (e) {
      reportError('emit_failed', e);
      return false;
    }
  }

  function reportError(code, err) {
    emit('bridge.error', {
      payload: { code: code, message: String((err && err.message) || err || code) },
    });
  }

  function detectShopInfo() {
    var shopName = '';
    var shopId = '';
    try {
      var title = String(document.title || '');
      var m = title.match(/^(.+?)[-–—]?(抖店|客服|工作台|消息)/);
      if (m && m[1]) shopName = m[1].trim();
      var u = new URL(location.href);
      shopId = u.searchParams.get('shopId') || u.searchParams.get('shop_id') || '';
    } catch (e) {}
    return { shopName: shopName, shopId: shopId };
  }

  function connect(url) {
    wsUrl = url || wsUrl;
    if (!wsUrl) return;
    try {
      if (ws) {
        try { ws.close(); } catch (e) {}
      }
      ws = new WebSocket(wsUrl);
      ws.onopen = function () {
        reconnectAttempt = 0;
        var shop = detectShopInfo();
        emit('bridge.hello', {
          shopId: shop.shopId,
          shopName: shop.shopName,
          payload: {
            pageUrl: location.href,
            pageTitle: document.title,
            userAgent: navigator.userAgent,
          },
          raw: { href: location.href, title: document.title },
        });
        emit('bridge.ready', {
          shopId: shop.shopId,
          shopName: shop.shopName,
          payload: {
            pageUrl: location.href,
            pageTitle: document.title,
            bridgeVersion: '0.1.0',
          },
        });
        startHeartbeat();
        installObservers();
        scanGlobalState();
      };
      ws.onmessage = function (ev) {
        handleServerMessage(ev.data);
      };
      ws.onclose = function () {
        stopHeartbeat();
        scheduleReconnect();
      };
      ws.onerror = function () {
        try {
          scheduleReconnect();
        } catch (e) {}
      };
    } catch (e) {
      reportError('ws_connect_failed', e);
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (!wsUrl) return;
    if (reconnectTimer) return;
    reconnectAttempt += 1;
    var delay = Math.min(config.reconnectBaseMs * reconnectAttempt, config.reconnectMaxMs);
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect(wsUrl);
    }, delay);
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(function () {
      emit('bridge.heartbeat', { payload: { ts: Date.now() } });
    }, config.heartbeatIntervalMs);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function handleServerMessage(raw) {
    var msg = safeJsonParse(String(raw || ''));
    if (!msg || !msg.type) return;
    if (msg.type === 'doudian.message.send_task') {
      handleSendTask(msg);
    }
  }

  // --- Layer 1: network observation ---
  var seenNetworkKeys = {};

  function rememberOnce(key) {
    if (seenNetworkKeys[key]) return false;
    seenNetworkKeys[key] = Date.now();
    var keys = Object.keys(seenNetworkKeys);
    if (keys.length > 500) {
      keys.sort(function (a, b) { return seenNetworkKeys[a] - seenNetworkKeys[b]; });
      for (var i = 0; i < 200; i++) delete seenNetworkKeys[keys[i]];
    }
    return true;
  }

  function maybeEmitMessageFromPayload(data, source) {
    try {
      if (!data || typeof data !== 'object') return;
      var text = data.content || data.text || data.message || data.msg || '';
      var messageId = data.messageId || data.msgId || data.id || '';
      var conversationId = data.conversationId || data.convId || data.sessionId || data.chatId || '';
      var buyerId = data.buyerId || data.userId || data.uid || '';
      var direction = data.direction || (data.isSeller || data.fromSeller ? 'outbound' : 'inbound');
      if (!text && !messageId) return;

      var dedupeKey = [conversationId, messageId, direction, String(text).slice(0, 80)].join('::');
      if (!rememberOnce(dedupeKey)) return;

      var eventType = direction === 'outbound' ? 'doudian.message.outbound' : 'doudian.message.inbound';
      emit(eventType, {
        conversationId: conversationId,
        buyerId: buyerId,
        messageId: messageId,
        payload: {
          text: String(text),
          direction: direction,
          messageType: data.messageType || data.type || 'text',
          source: source,
        },
        raw: data,
      });
    } catch (e) {
      reportError('network_parse_failed', e);
    }
  }

  function inspectNetworkJson(obj, source) {
    if (!obj) return;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) inspectNetworkJson(obj[i], source);
      return;
    }
    if (typeof obj !== 'object') return;

    if (obj.messages && Array.isArray(obj.messages)) {
      for (var j = 0; j < obj.messages.length; j++) maybeEmitMessageFromPayload(obj.messages[j], source);
    }
    if (obj.messageList && Array.isArray(obj.messageList)) {
      for (var k = 0; k < obj.messageList.length; k++) maybeEmitMessageFromPayload(obj.messageList[k], source);
    }
    maybeEmitMessageFromPayload(obj, source);

    if (obj.aftersaleId || obj.refundId || obj.afterSaleId) {
      emit('doudian.aftersale.updated', {
        payload: {
          aftersaleId: String(obj.aftersaleId || obj.refundId || obj.afterSaleId || ''),
          orderId: String(obj.orderId || obj.order_id || ''),
          status: String(obj.status || obj.aftersaleStatus || ''),
          reason: String(obj.reason || obj.refundReason || ''),
          amount: String(obj.amount || obj.refundAmount || ''),
          text: String(obj.text || obj.desc || ''),
        },
        raw: obj,
      });
    }

    if (obj.orderId || obj.order_id) {
      emit('doudian.order.context', {
        payload: {
          orderId: String(obj.orderId || obj.order_id || ''),
          productTitle: String(obj.productTitle || obj.product_name || ''),
          sku: String(obj.sku || obj.skuName || ''),
          price: String(obj.price || obj.payAmount || ''),
          quantity: String(obj.quantity || obj.num || ''),
          payTime: String(obj.payTime || obj.pay_time || ''),
          orderStatus: String(obj.orderStatus || obj.status || ''),
          logisticsStatus: String(obj.logisticsStatus || ''),
          aftersaleStatus: String(obj.aftersaleStatus || ''),
        },
        raw: obj,
      });
    }
  }

  function hookWebSocket() {
    if (window.WebSocket && window.WebSocket.__doudianHooked) return;
    var Orig = window.WebSocket;
    if (!Orig) return;

    function PatchedWebSocket(url, protocols) {
      var instance = protocols !== undefined ? new Orig(url, protocols) : new Orig(url);
      try {
        var u = String(url || '');
        if (/im|message|chat|cs|jinritemai|doudian/i.test(u)) {
          var origSend = instance.send;
          instance.send = function (data) {
            try {
              var parsed = safeJsonParse(String(data || ''));
              if (parsed) inspectNetworkJson(parsed, 'ws_send');
            } catch (e) {}
            return origSend.apply(instance, arguments);
          };
          instance.addEventListener('message', function (ev) {
            try {
              var parsed = safeJsonParse(String(ev.data || ''));
              if (parsed) inspectNetworkJson(parsed, 'ws_recv');
            } catch (e) {}
          });
        }
      } catch (e) {}
      return instance;
    }
    PatchedWebSocket.prototype = Orig.prototype;
    Object.setPrototypeOf(PatchedWebSocket, Orig);
    PatchedWebSocket.__doudianHooked = true;
    window.WebSocket = PatchedWebSocket;
  }

  function hookFetch() {
    if (window.__doudianFetchHooked) return;
    window.__doudianFetchHooked = true;
    var origFetch = window.fetch;
    if (!origFetch) return;
    window.fetch = function () {
      return origFetch.apply(this, arguments).then(function (res) {
        try {
          var clone = res.clone();
          var url = String((arguments[0] && arguments[0].url) || arguments[0] || '');
          if (/message|chat|im|aftersale|refund|order|conversation/i.test(url)) {
            clone.json().then(function (json) {
              inspectNetworkJson(json, 'fetch:' + url.slice(0, 120));
            }).catch(function () {});
          }
        } catch (e) {}
        return res;
      });
    };
  }

  function hookXHR() {
    if (window.__doudianXhrHooked) return;
    window.__doudianXhrHooked = true;
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__doudianUrl = String(url || '');
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      xhr.addEventListener('load', function () {
        try {
          var url = String(xhr.__doudianUrl || '');
          if (!/message|chat|im|aftersale|refund|order|conversation/i.test(url)) return;
          var parsed = safeJsonParse(String(xhr.responseText || ''));
          if (parsed) inspectNetworkJson(parsed, 'xhr:' + url.slice(0, 120));
        } catch (e) {}
      });
      return origSend.apply(this, arguments);
    };
  }

  // --- Layer 2: DOM observer ---
  var domObserver = null;
  var seenDomKeys = {};

  function extractText(el) {
    if (!el) return '';
    return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function observeDom() {
    if (domObserver) return;
    var selectors = config.selectors || {};
    var targets = [];
    var selectorList = [
      selectors.chatContainer,
      selectors.conversationList,
      selectors.aftersaleCard,
      selectors.orderCard,
      "[class*='chat']",
      "[class*='message']",
    ].filter(Boolean);

    for (var i = 0; i < selectorList.length; i++) {
      try {
        var nodes = document.querySelectorAll(selectorList[i]);
        for (var j = 0; j < nodes.length; j++) targets.push(nodes[j]);
      } catch (e) {}
    }

    if (!targets.length) {
      emit('doudian.runtime.log', {
        payload: { level: 'warn', message: 'DOM 观察器未找到聊天区域，选择器待配置', selectors: selectorList },
      });
      return;
    }

    domObserver = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var added = mutations[m].addedNodes || [];
        for (var n = 0; n < added.length; n++) {
          var node = added[n];
          if (!node || node.nodeType !== 1) continue;
          var text = extractText(node).slice(0, 500);
          if (!text || text.length < 2) continue;
          var key = 'dom::' + text.slice(0, 120);
          if (seenDomKeys[key]) continue;
          seenDomKeys[key] = Date.now();

          var cls = String(node.className || '');
          var direction = /seller|staff|self|mine|客服/.test(cls) ? 'outbound' : 'inbound';
          emit('doudian.message.inbound', {
            conversationId: '',
            messageId: 'dom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            payload: {
              text: text,
              direction: direction,
              messageType: 'text',
              source: 'dom_observer',
            },
            raw: { className: cls },
          });

          if (/售后|退款|退货|仅退款|平台介入|待商家处理|即将超时/.test(text)) {
            emit('doudian.aftersale.need_handle', {
              payload: {
                aftersaleId: '',
                orderId: '',
                conversationId: '',
                buyerId: '',
                status: '',
                reason: '',
                amount: '',
                deadline: '',
                text: text,
                timestamp: Date.now(),
              },
            });
          }
        }
      }
    });

    for (var t = 0; t < targets.length; t++) {
      try {
        domObserver.observe(targets[t], { childList: true, subtree: true, characterData: true });
      } catch (e) {}
    }
  }

  // --- Layer 3: global state probe ---
  function scanGlobalState() {
    var keys = Object.keys(window).filter(function (k) {
      return /store|router|state|chat|im|conversation|seller|shop/i.test(k);
    }).slice(0, 30);

    var snapshot = {};
    for (var i = 0; i < keys.length; i++) {
      try {
        var val = window[keys[i]];
        if (val == null) continue;
        if (typeof val === 'function') continue;
        if (typeof val === 'object') {
          var brief = {};
          var subKeys = Object.keys(val).slice(0, 12);
          for (var j = 0; j < subKeys.length; j++) {
            var sk = subKeys[j];
            if (SENSITIVE_RE.test(sk)) continue;
            var sv = val[sk];
            if (typeof sv === 'string' || typeof sv === 'number' || typeof sv === 'boolean') {
              brief[sk] = sv;
            }
          }
          snapshot[keys[i]] = brief;
        }
      } catch (e) {}
    }

    emit('doudian.runtime.log', {
      payload: { level: 'debug', message: 'global_state_probe', keys: keys, snapshot: snapshot },
    });
  }

  function installObservers() {
    try {
      hookWebSocket();
      hookFetch();
      hookXHR();
      observeDom();
    } catch (e) {
      reportError('observer_install_failed', e);
    }
  }

  // --- send message ---
  var pendingSendAcks = {};

  function setInputValue(input, text) {
    if (!input) return false;
    try {
      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      if (input.isContentEditable) {
        input.textContent = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
    } catch (e) {}
    return false;
  }

  function clickSendButton() {
    var selectors = (config.selectors && config.selectors.sendButton) || "button[class*='send'], [class*='send-btn']";
    try {
      var btn = document.querySelector(selectors);
      if (btn) {
        btn.click();
        return true;
      }
    } catch (e) {}
    return false;
  }

  function findMessageInput() {
    var selectors = (config.selectors && config.selectors.messageInput) || "textarea, [contenteditable='true']";
    try {
      return document.querySelector(selectors);
    } catch (e) {
      return null;
    }
  }

  function handleSendTask(msg) {
    var taskId = (msg.payload && msg.payload.taskId) || ('task-' + Date.now());
    var text = String((msg.payload && msg.payload.text) || '');
    var conversationId = String(msg.conversationId || (msg.payload && msg.payload.conversationId) || '');

    try {
      if (conversationId) {
        switchConversation(conversationId);
      }
      var input = findMessageInput();
      if (!input) {
        emit('doudian.message.send_failed', {
          conversationId: conversationId,
          payload: { taskId: taskId, reason: 'input_not_found', text: text },
        });
        return;
      }
      setInputValue(input, text);
      var clicked = clickSendButton();
      if (!clicked) {
        emit('doudian.message.send_failed', {
          conversationId: conversationId,
          payload: { taskId: taskId, reason: 'send_button_not_found', text: text },
        });
        return;
      }
      emit('doudian.message.ack', {
        conversationId: conversationId,
        messageId: taskId,
        payload: { taskId: taskId, text: text, method: 'dom_fallback' },
      });
      emit('doudian.message.outbound', {
        conversationId: conversationId,
        messageId: taskId,
        payload: { text: text, direction: 'outbound', messageType: 'text', source: 'send_task' },
      });
    } catch (e) {
      emit('doudian.message.send_failed', {
        conversationId: conversationId,
        payload: { taskId: taskId, reason: String(e.message || e), text: text },
      });
    }
  }

  function switchConversation(conversationId) {
    if (!conversationId) return false;
    var selectors = [
      '[data-conversation-id="' + conversationId + '"]',
      '[data-session-id="' + conversationId + '"]',
      '[data-cid="' + conversationId + '"]',
    ];
    for (var i = 0; i < selectors.length; i++) {
      try {
        var el = document.querySelector(selectors[i]);
        if (el) {
          el.click();
          return true;
        }
      } catch (e) {}
    }
    return false;
  }

  var bridgeApi = {
    __installed: true,
    bridgeId: bridgeId,
    connect: connect,
    emit: emit,
    getState: function () {
      return {
        bridgeId: bridgeId,
        wsUrl: wsUrl,
        connected: !!(ws && ws.readyState === 1),
        pageUrl: location.href,
        pageTitle: document.title,
      };
    },
    configure: function (opts) {
      config = Object.assign(config, opts || {});
    },
    rescan: function () {
      scanGlobalState();
      observeDom();
    },
  };

  window.__DOUDIAN_BRIDGE__ = bridgeApi;
  window.__DOUDIAN_BRIDGE = bridgeApi;

  return { ok: true, bridgeId: bridgeId };
})();
