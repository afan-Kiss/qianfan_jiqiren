/**
 * 生成注入到 preload 的运行时代码（浏览器端字符串）
 */
const { getDoudianConfig } = require('../../../shared/config');
const { buildChatDomInspectionCode } = require('./doudian-chat-dom-inspection-snippet');
const { buildReplyEditorBrowserCode } = require('./doudian-reply-editor-snippet');
const { buildMessageSendBrowserCode } = require('./doudian-message-send-snippet');
const { buildConversationListBrowserCode } = require('./doudian-conversation-list-snippet');
const { buildConversationSourcesBrowserCode } = require('./doudian-conversation-sources-snippet');

function buildInjectedRuntimeCode(options = {}) {
  const cfg = getDoudianConfig();
  const knownShops = options.knownShops || cfg.knownShops || [
    { shopId: '263636465', shopName: 'XY祥钰珠宝' },
    { shopId: '276595872', shopName: '梵诗娅珠宝' },
  ];

  return `
    var KNOWN_SHOPS = ${JSON.stringify(knownShops)};
    var networkBuffer = [];
    var networkBufferMax = 100;
    var observerStarted = false;
    var networkHookInstalled = false;
    var networkLightMode = true;
    var domObserver = null;
    var seenDomKeys = Object.create(null);
    var seenNetworkKeys = Object.create(null);
    var shopCache = Object.create(null);
    var shopIdentitySource = 'unknown';

    var NETWORK_URL_KEYWORDS = /pigeon\\.jinritemai\\.com|chat\\/api\\/backstage|conversation|currentuser|get_current_conversation_list|get_link_info|message|\\/im/i;
    var EXTRACT_FIELD_KEYS = {
      shopId: 1, shop_id: 1, shopName: 1, shop_name: 1, accountId: 1, userId: 1, user_id: 1,
      sellerId: 1, conversationId: 1, conversation_id: 1, conversation_short_id: 1,
      buyerId: 1, buyer_id: 1, nickName: 1, nickname: 1, name: 1,
      messageId: 1, message_id: 1, serverMessageId: 1, content: 1, text: 1, msg: 1, message: 1,
      sendTime: 1, createTime: 1, timestamp: 1
    };
    var EMPTY_STATE_PATTERNS = ['暂无会话中用户', '请选择会话', '与消费者聊天', '您今日暂无接待数据'];
    var CONTAINER_SELECTORS = [
      '#chatListScrollArea', '#chantListScrollArea',
      '[id*="chant"]', '[id*="chat"]', '[class*="chat"]', '[class*="message"]',
      '[class*="conversation"]', '[class*="session"]', '[class*="im"]'
    ];

    function sanitizeUrl(url) {
      try {
        var u = new URL(url, typeof location !== 'undefined' ? location.href : 'https://im.jinritemai.com/');
        var params = u.searchParams;
        ['token','cookie','auth','sign','session','csrf','authorization','ticket'].forEach(function (k) {
          if (params.has(k)) params.set(k, '[redacted]');
        });
        var q = params.toString();
        return u.origin + u.pathname + (q ? '?' + q.slice(0, 80) : '');
      } catch (e) {
        return safeString(url).slice(0, 120);
      }
    }

    function maskSensitiveText(text) {
      var s = safeString(text);
      s = s.replace(/1\\d{10}/g, function (m) { return m.slice(0, 3) + '****' + m.slice(-4); });
      s = s.replace(/\\d{15,20}/g, function (m) { return m.slice(0, 4) + '****' + m.slice(-4); });
      return s;
    }

    function pushNetworkBuffer(item) {
      networkBuffer.push(item);
      if (networkBuffer.length > networkBufferMax) networkBuffer.shift();
    }

    function shallowExtract(obj, depth, counter, bag) {
      if (!obj || depth > 5 || counter.n > 2000) return counter;
      counter.n++;
      if (Array.isArray(obj)) {
        for (var i = 0; i < obj.length && i < 40; i++) shallowExtract(obj[i], depth + 1, counter, bag);
        return counter;
      }
      if (typeof obj !== 'object') return counter;
      for (var key in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
        var val = obj[key];
        var lk = safeString(key);
        if (EXTRACT_FIELD_KEYS[lk] || EXTRACT_FIELD_KEYS[lk.toLowerCase()]) {
          if (typeof val === 'string' || typeof val === 'number') {
            bag[lk] = safeString(val).slice(0, 1000);
          }
        }
        if (val && typeof val === 'object') shallowExtract(val, depth + 1, counter, bag);
      }
      return counter;
    }

    function applyShopFromBag(bag, source) {
      if (!bag) return;
      if (bag.shopId || bag.shop_id) shopCache.shopId = pickFirst(bag.shopId, bag.shop_id);
      if (bag.shopName || bag.shop_name) shopCache.shopName = pickFirst(bag.shopName, bag.shop_name);
      if (bag.accountId || bag.userId || bag.user_id) shopCache.accountId = pickFirst(bag.accountId, bag.userId, bag.user_id);
      if (bag.sessionPartitionKey) shopCache.sessionPartitionKey = bag.sessionPartitionKey;
      if ((bag.shopId || bag.shop_id || bag.shopName || bag.shop_name) && source) {
        shopIdentitySource = source;
        shopCache.shopIdentitySource = source;
      }
    }

    function applyKnownShopMapping(info) {
      var out = info || {};
      var name = pickFirst(out.shopName, out.activeShopNameFromDom);
      if (!out.shopId && name) {
        for (var i = 0; i < KNOWN_SHOPS.length; i++) {
          var ks = KNOWN_SHOPS[i];
          if (!ks || !ks.shopName) continue;
          if (name.indexOf(ks.shopName) >= 0 || ks.shopName.indexOf(name) >= 0) {
            out.shopId = ks.shopId;
            out.shopName = out.shopName || ks.shopName;
            out.shopIdentitySource = out.shopIdentitySource || 'knownShops';
            break;
          }
        }
      }
      return out;
    }

    function readGlobalShopHintsShallow() {
      var bag = {};
      var counter = { n: 0 };
      var roots = [
        window.__INITIAL_STATE__, window.__NUXT__, window.__STORE__,
        window.g_initialData, window.__prefetchData, window.currentUser, window.userInfo
      ];
      for (var i = 0; i < roots.length; i++) {
        if (roots[i] && typeof roots[i] === 'object') shallowExtract(roots[i], 0, counter, bag);
      }
      return bag;
    }

    function readDomShopHints() {
      var activeShopNameFromDom = '';
      var activeShopIdFromDom = '';
      var shopNames = [];
      try {
        if (typeof document === 'undefined' || !document) return { activeShopNameFromDom, activeShopIdFromDom, shopNames };
        var nodes = document.querySelectorAll('[class*="shop"], [class*="store"], [class*="account"], [data-shop-id], [data-shopid], [class*="tab"]');
        for (var i = 0; i < nodes.length && i < 120; i++) {
          var el = nodes[i];
          var text = safeString(el.innerText || el.textContent).trim();
          var ds = pickFirst(el.getAttribute('data-shop-id'), el.getAttribute('data-shopid'));
          if (ds) activeShopIdFromDom = activeShopIdFromDom || ds;
          if (text && text.length >= 2 && text.length <= 40 && !/1\\d{10}/.test(text)) {
            if (shopNames.indexOf(text) < 0) shopNames.push(text);
            if (!activeShopNameFromDom && !/^(消息|客服|设置|首页|工作台|抖店|飞鸽)$/.test(text)) activeShopNameFromDom = text;
          }
        }
        var title = safeString(document.title);
        if (title && title.length <= 40 && !activeShopNameFromDom && title.indexOf('飞鸽') < 0) {
          activeShopNameFromDom = title.split('-')[0].trim();
        }
        var bodyText = safeString(document.body && document.body.innerText);
        for (var ki = 0; ki < KNOWN_SHOPS.length; ki++) {
          var ks = KNOWN_SHOPS[ki];
          if (ks && ks.shopName && bodyText.indexOf(ks.shopName) >= 0) {
            if (shopNames.indexOf(ks.shopName) < 0) shopNames.push(ks.shopName);
            if (!activeShopNameFromDom) activeShopNameFromDom = ks.shopName;
            if (!activeShopIdFromDom && ks.shopId) activeShopIdFromDom = ks.shopId;
          }
        }
      } catch (e) {}
      return { activeShopNameFromDom, activeShopIdFromDom, shopNames };
    }

    function resolveShopIdentity() {
      var domHints = readDomShopHints();
      var globalBag = readGlobalShopHintsShallow();
      applyShopFromBag(globalBag, globalBag.shopId || globalBag.shop_id ? 'global' : '');
      var info = {
        shopId: pickFirst(shopCache.shopId, globalBag.shopId, globalBag.shop_id, domHints.activeShopIdFromDom),
        shopName: pickFirst(shopCache.shopName, globalBag.shopName, globalBag.shop_name, domHints.activeShopNameFromDom),
        accountId: pickFirst(shopCache.accountId, globalBag.accountId, globalBag.userId, globalBag.user_id),
        sessionPartitionKey: pickFirst(shopCache.sessionPartitionKey, globalBag.sessionPartitionKey),
        loginDomainType: pickFirst(shopCache.loginDomainType, globalBag.loginDomainType),
        activeShopNameFromDom: domHints.activeShopNameFromDom,
        activeShopIdFromDom: domHints.activeShopIdFromDom,
        detectedShopNames: domHints.shopNames.slice(0, 10),
        shopIdentitySource: pickFirst(shopCache.shopIdentitySource, shopIdentitySource, 'unknown'),
      };
      info = applyKnownShopMapping(info);
      if (info.shopId && info.shopIdentitySource === 'unknown') info.shopIdentitySource = 'network';
      if (!info.shopId && info.shopName && info.shopIdentitySource === 'knownShops') {}
      else if (!info.shopId && info.shopName) info.shopIdentitySource = info.shopIdentitySource === 'unknown' ? 'dom' : info.shopIdentitySource;
      if (info.shopId) shopCache.shopId = info.shopId;
      if (info.shopName) shopCache.shopName = info.shopName;
      if (info.accountId) shopCache.accountId = info.accountId;
      shopIdentitySource = info.shopIdentitySource;
      shopCache.shopIdentitySource = info.shopIdentitySource;
      return info;
    }

    function getShopInfo() {
      return resolveShopIdentity();
    }

    function processNetworkBody(url, body, sourceType) {
      if (!body || body.length > 300000) return;
      var urlStr = safeString(url);
      if (!NETWORK_URL_KEYWORDS.test(urlStr) && !NETWORK_URL_KEYWORDS.test(body.slice(0, 500))) return;
      var bag = {};
      var counter = { n: 0 };
      try {
        var json = JSON.parse(body);
        shallowExtract(json, 0, counter, bag);
        if (/currentuser|getCustomerServiceAllPermission|get_link_info|get_current_conversation/i.test(urlStr)) {
          var extra = {};
          shallowExtract(json.data || json.result || json, 0, { n: 0 }, extra);
          for (var ek in extra) bag[ek] = extra[ek];
          if (json.data && json.data.shop) shallowExtract(json.data.shop, 0, { n: 0 }, bag);
          if (json.data && json.data.user) shallowExtract(json.data.user, 0, { n: 0 }, bag);
          if (json.data && json.data.shop_info) shallowExtract(json.data.shop_info, 0, { n: 0 }, bag);
        }
        applyShopFromBag(bag, 'network');
        var item = {
          url: sanitizeUrl(urlStr),
          source: sourceType,
          shopHints: {
            shopId: pickFirst(bag.shopId, bag.shop_id, shopCache.shopId),
            shopName: pickFirst(bag.shopName, bag.shop_name, shopCache.shopName),
            conversationId: pickFirst(bag.conversationId, bag.conversation_id),
          },
          fieldCount: counter.n,
          textSample: maskSensitiveText(pickFirst(bag.content, bag.text, bag.msg, bag.message)).slice(0, 200),
          timestamp: Date.now(),
        };
        pushNetworkBuffer(item);
        if (!networkLightMode || observerStarted) {
          if (item.shopHints.shopId || item.shopHints.shopName || item.textSample) {
            send('doudian.message.network_candidate', {
              source: sourceType,
              captureMode: 'diagnostic',
              shopId: getShopInfo().shopId,
              shopName: getShopInfo().shopName,
              urlPath: item.url,
              text: item.textSample,
              shopHints: item.shopHints,
              timestamp: Date.now(),
            });
          }
        }
      } catch (e) {}
    }

    function installNetworkHooks(forceLight) {
      if (networkHookInstalled) return;
      networkHookInstalled = true;
      if (typeof forceLight === 'boolean') networkLightMode = forceLight;
      try {
        var origFetch = window.fetch;
        if (origFetch) {
          window.fetch = function () {
            var reqUrl = arguments[0] && arguments[0].url ? arguments[0].url : arguments[0];
            return origFetch.apply(this, arguments).then(function (resp) {
              try {
                var respUrl = safeString(resp.url || reqUrl);
                if (NETWORK_URL_KEYWORDS.test(respUrl)) {
                  resp.clone().text().then(function (body) {
                    processNetworkBody(respUrl, body, 'fetch');
                  }).catch(function () {});
                }
              } catch (e) {}
              return resp;
            });
          };
        }
      } catch (e) {}
      try {
        var XO = XMLHttpRequest.prototype.open;
        var XS = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__doudianUrl = url;
          return XO.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
          var xhr = this;
          var reqUrl = safeString(xhr.__doudianUrl);
          xhr.addEventListener('load', function () {
            try {
              if (NETWORK_URL_KEYWORDS.test(reqUrl)) {
                processNetworkBody(reqUrl, safeString(xhr.responseText), 'xhr');
              }
            } catch (e) {}
          });
          return XS.apply(this, arguments);
        };
      } catch (e) {}
    }

    function maybeInstallEarlyNetworkHook() {
      try {
        if (isImHref(safeString(location && location.href))) installNetworkHooks(true);
      } catch (e) {}
    }

    function replayNetworkBuffer() {
      var shop = getShopInfo();
      send('doudian.network.buffer_replay', {
        bridgeId: bridgeId,
        shopInfo: shop,
        items: networkBuffer.slice(-100),
        count: networkBuffer.length,
      });
    }

    function runImDomDiagnostic() {
      var page = getPageInfo();
      var candidateContainers = [];
      for (var ci = 0; ci < CONTAINER_SELECTORS.length; ci++) {
        var sel = CONTAINER_SELECTORS[ci];
        try {
          var nodes = document.querySelectorAll(sel);
          var node = nodes.length ? nodes[0] : null;
          var sampleText = '';
          var childCount = 0;
          var textLength = 0;
          if (node) {
            childCount = node.childElementCount || 0;
            sampleText = maskSensitiveText(safeString(node.innerText || node.textContent)).slice(0, 300);
            textLength = sampleText.length;
          }
          candidateContainers.push({
            selector: sel,
            exists: !!node,
            matchCount: nodes.length,
            childCount: childCount,
            textLength: textLength,
            sampleText: sampleText,
          });
        } catch (e) {
          candidateContainers.push({ selector: sel, exists: false, error: 'scan_failed' });
        }
      }
      var textSamples = collectTextSamples(20);
      var inputCandidates = [];
      var buttonCandidates = [];
      try {
        document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]').forEach(function (el, idx) {
          if (idx >= 8) return;
          inputCandidates.push({ tag: el.tagName, className: safeString(el.className).slice(0, 80), visible: !!(el.offsetParent) });
        });
        document.querySelectorAll('button, [role="button"]').forEach(function (el, idx) {
          if (idx >= 12) return;
          var t = safeString(el.innerText || el.textContent).trim().slice(0, 40);
          if (t) buttonCandidates.push({ text: t, className: safeString(el.className).slice(0, 60) });
        });
      } catch (e) {}
      send('doudian.im.dom_diagnostic', {
        bridgeId: bridgeId,
        shopInfo: getShopInfo(),
        href: page.href,
        title: page.title,
        readyState: page.readyState,
        bodyTextLength: page.bodyTextLength,
        candidateContainers: candidateContainers,
        textSamples: textSamples,
        inputCandidates: inputCandidates,
        buttonCandidates: buttonCandidates,
      });
    }

    function collectTextSamples(maxCount) {
      var out = [];
      if (typeof document === 'undefined' || !document) return out;
      try {
        var nodes = document.querySelectorAll('div, span, p, li, td');
        for (var i = 0; i < nodes.length && out.length < maxCount; i++) {
          var el = nodes[i];
          if (!el || el.children.length > 6) continue;
          var text = safeString(el.innerText || el.textContent).trim();
          if (text.length < 2 || text.length > 300) continue;
          if (/^(首页|消息|设置|客服|工作台|发送|确定|取消|更多)$/.test(text)) continue;
          if (/^1\\d{10}$/.test(text)) continue;
          var masked = maskSensitiveText(text);
          if (out.indexOf(masked) >= 0) continue;
          out.push(masked);
        }
      } catch (e) {}
      return out;
    }

    function detectEmptyState() {
      try {
        var bodyText = safeString(document.body && document.body.innerText);
        for (var i = 0; i < EMPTY_STATE_PATTERNS.length; i++) {
          var pat = EMPTY_STATE_PATTERNS[i];
          if (bodyText.indexOf(pat) >= 0) {
            send('doudian.im.empty_state', {
              shopInfo: getShopInfo(),
              stateText: pat,
              reason: 'no_active_conversation',
              href: safeString(location.href),
            });
            return true;
          }
        }
      } catch (e) {}
      return false;
    }

    function emitDomCandidate(text, selectorHint) {
      var raw = safeString(text).trim();
      if (!raw) return;
      if (raw.indexOf('\\n') >= 0) {
        var parts = raw.split(/\\n+/);
        for (var pi = 0; pi < parts.length; pi++) {
          emitDomCandidate(parts[pi], selectorHint);
        }
        return;
      }
      if (isUiNoise(raw)) {
        emitUiNoiseSample(raw);
        return;
      }
      var shop = getShopInfo();
      var payload = {
        source: 'dom',
        captureMode: 'diagnostic',
        shopId: shop.shopId,
        shopName: shop.shopName,
        accountId: maskValue(shop.accountId),
        sessionPartitionKey: shop.sessionPartitionKey,
        text: maskSensitiveText(raw).slice(0, 1000),
        direction: 'unknown',
        selectorHint: selectorHint || '',
        visible: true,
        rawTextHash: hashText(raw),
        timestamp: Date.now(),
        pageHref: safeString(location.href),
        bridgeId: bridgeId,
        isRealMessageCandidate: false,
      };
      send('doudian.message.dom_candidate', payload);
    }

    function scanDomCandidatesDiagnostic() {
      var total = 0;
      for (var ci = 0; ci < CONTAINER_SELECTORS.length; ci++) {
        var sel = CONTAINER_SELECTORS[ci];
        try {
          var nodes = document.querySelectorAll(sel);
          for (var ni = 0; ni < nodes.length && ni < 30; ni++) {
            var el = nodes[ni];
            var chunks = safeString(el.innerText || el.textContent).split(/\\n+/);
            for (var ti = 0; ti < chunks.length && total < 60; ti++) {
              var text = chunks[ti].trim();
              if (text.length < 2 || text.length > 300) continue;
              var key = hashText(sel + ':' + text.slice(0, 120));
              if (seenDomKeys[key]) continue;
              seenDomKeys[key] = 1;
              emitDomCandidate(text, sel);
              total++;
            }
          }
        } catch (e) {}
      }
      if (total === 0) {
        var samples = collectTextSamples(15);
        for (var si = 0; si < samples.length; si++) emitDomCandidate(samples[si], 'textSamples');
      }
      return total;
    }

    function startMessageObserver() {
      var page = getPageInfo();
      if (!page.isImWorkspace) {
        send('bridge.log', { command: 'debug.start_message_observer', success: false, reason: 'not_im_page', info: page });
        return;
      }
      networkLightMode = false;
      installNetworkHooks(false);
      var shop = resolveShopIdentity();
      if (!observerStarted) observerStarted = true;
      replayNetworkBuffer();
      runImDomDiagnostic();
      var empty = detectEmptyState();
      var domCount = scanDomCandidatesDiagnostic();
      try {
        if (!domObserver && document.body) {
          domObserver = new MutationObserver(function () {
            scanDomCandidatesDiagnostic();
          });
          domObserver.observe(document.body, { childList: true, subtree: true });
        }
      } catch (e) {}
      send('doudian.message.observer_ready', {
        success: true,
        shopInfo: shop,
        shopId: shop.shopId,
        shopName: shop.shopName,
        accountId: maskValue(shop.accountId),
        sessionPartitionKey: shop.sessionPartitionKey,
        shopIdentitySource: shop.shopIdentitySource,
        info: page,
        domCandidateCount: domCount,
        emptyStateDetected: empty,
        networkBufferCount: networkBuffer.length,
      });
    }

    ${buildChatDomInspectionCode()}
    ${buildReplyEditorBrowserCode()}
    ${buildMessageSendBrowserCode()}
    ${buildConversationListBrowserCode()}
    ${buildConversationSourcesBrowserCode()}
`;
}

module.exports = {
  buildInjectedRuntimeCode,
};
