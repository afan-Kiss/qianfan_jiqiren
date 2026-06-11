/**
 * 浏览器端：多源会话解析（memory cache + React Fiber + DOM 几何 + 选中兜底）
 */
const { buildReactFiberInspectorBrowserCode } = require('./doudian-react-fiber-inspector');

function buildConversationSourcesBrowserCode() {
  return `
    ${buildReactFiberInspectorBrowserCode()}

    var CONV_CACHE_KEY_RE = /get_current_conversation_list|conversation|current_conversation|get_link_info|pigeon|chat\\/api\\/backstage/i;

    function normalizeConvRow(row, source, selected) {
      if (!row || typeof row !== 'object') return null;
      var buyerId = pickFirst(row.buyerId, row.buyer_id, row.userId, row.user_id, row.uid);
      var buyerName = pickFirst(row.buyerName, row.nickName, row.nickname, row.name, row.user_name);
      var conversationId = pickFirst(row.conversationId, row.conversation_id, row.conversation_short_id);
      var lastMessage = pickFirst(row.lastMessage, row.last_message, row.content, row.text, row.msg, row.message, row.lastMessageText);
      var timeText = pickFirst(row.timeText, row.time, row.lastMessageTime, row.timestamp, row.sendTime, row.createTime);
      if (!buyerId && !buyerName && !conversationId) return null;
      if (buyerName && (BLOCKED_BUYER_LABELS.test(buyerName) || isUiNoise(buyerName) || /暂无接待|全店数据|暂无会话|请选择会话|您今日暂无|前往查看/.test(buyerName))) return null;
      if (buyerId && (/llm|proc|worker|bridge|patch|debug|rust|electron|preload/i.test(buyerId) || buyerId.length < 10)) return null;
      return {
        buyerId: maskValue(buyerId),
        buyerName: maskSensitiveText(buyerName).slice(0, 60),
        conversationId: maskValue(conversationId),
        lastMessage: maskSensitiveText(safeString(lastMessage).slice(0, 120)),
        timeText: maskSensitiveText(safeString(timeText).slice(0, 40)),
        unreadCount: Number(pickFirst(row.unreadCount, row.unread_count, row.unread)) || 0,
        selected: !!selected,
        source: source || 'unknown'
      };
    }

    function collectConversationRowsFromPayload(payload, source) {
      var conversations = [];
      var seen = Object.create(null);
      if (!payload) return conversations;

      function pushRow(row, selected) {
        var norm = normalizeConvRow(row, source, selected);
        if (!norm) return;
        var key = (norm.conversationId || '') + ':' + (norm.buyerId || '') + ':' + (norm.buyerName || '');
        if (seen[key]) return;
        seen[key] = 1;
        conversations.push(norm);
      }

      function walkArrays(obj, depth) {
        if (!obj || depth > 6) return;
        if (Array.isArray(obj)) {
          for (var i = 0; i < obj.length && i < 50; i++) {
            var item = obj[i];
            if (item && typeof item === 'object') {
              pushRow(item, !!(item.active || item.selected || item.isActive || item.is_current));
            }
          }
          return;
        }
        if (typeof obj !== 'object') return;
        for (var k in obj) {
          if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
          if (/cookie|token|csrf|authorization|ticket|sign|password|secret|header/i.test(k)) continue;
          walkArrays(obj[k], depth + 1);
        }
      }

      if (Array.isArray(payload)) walkArrays(payload, 0);
      else if (payload.data) walkArrays(payload.data, 0);
      else if (payload.result) walkArrays(payload.result, 0);
      else if (payload.list) walkArrays(payload.list, 0);
      else if (payload.link_info) pushRow(payload.link_info, true);
      else walkArrays(payload, 0);

      return conversations.slice(0, 20);
    }

    function parseMemoryCachePayload(payload, cacheKey, apiName) {
      var conversations = collectConversationRowsFromPayload(payload, 'memory_cache');
      var selectedConversation = {};
      for (var i = 0; i < conversations.length; i++) {
        if (conversations[i].selected) {
          selectedConversation = conversations[i];
          break;
        }
      }
      if (!selectedConversation.buyerName && !selectedConversation.buyerId && conversations.length) {
        selectedConversation = conversations[0];
      }
      return {
        source: 'memory_cache',
        cacheKey: sanitizeUrl(safeString(cacheKey).slice(0, 200)),
        apiName: apiName || 'unknown',
        conversationCount: conversations.length,
        conversations: conversations,
        selectedConversation: selectedConversation
      };
    }

    function scanNetworkBufferForConversations() {
      var best = { source: 'memory_cache', cacheKey: '', apiName: 'unknown', conversationCount: 0, conversations: [], selectedConversation: {} };
      try {
        for (var i = networkBuffer.length - 1; i >= 0; i--) {
          var item = networkBuffer[i];
          if (!item) continue;
          var key = safeString(item.url || item.cacheKey || item.key || '');
          if (!CONV_CACHE_KEY_RE.test(key)) continue;
          var body = item.body || item.response || item.payload || item.data;
          if (!body) continue;
          var parsed = null;
          try { parsed = typeof body === 'string' ? JSON.parse(body) : body; } catch (e) { parsed = body; }
          var block = parseMemoryCachePayload(parsed, key, resolveApiNameFromKey(key));
          if (block.conversationCount > best.conversationCount) best = block;
        }
      } catch (e) {}
      return best;
    }

    function resolveApiNameFromKey(key) {
      var u = safeString(key).toLowerCase();
      if (u.indexOf('get_current_conversation_list') >= 0) return 'get_current_conversation_list';
      if (u.indexOf('get_link_info') >= 0) return 'get_link_info';
      if (u.indexOf('pigeon') >= 0) return 'pigeon';
      if (u.indexOf('conversation') >= 0) return 'conversation';
      if (u.indexOf('chat/api/backstage') >= 0) return 'chat_api_backstage';
      return 'unknown';
    }

    function probeMemoryCacheKeys() {
      var keys = [];
      var part = shopCache.sessionPartitionKey || shopCache.accountId || '';
      if (part) {
        keys.push(part + ':get_current_conversation_list');
        keys.push('persist:' + part.replace(/^persist:/, '') + ':get_current_conversation_list');
      }
      try {
        for (var i = networkBuffer.length - 1; i >= 0 && keys.length < 30; i--) {
          var item = networkBuffer[i];
          var k = safeString(item && (item.url || item.cacheKey || item.key));
          if (k && CONV_CACHE_KEY_RE.test(k) && keys.indexOf(k) < 0) keys.push(k);
        }
      } catch (e) {}
      return keys.slice(0, 20);
    }

    function probeMemoryCacheConversationsAsync() {
      var bufferResult = scanNetworkBufferForConversations();
      var keys = probeMemoryCacheKeys();
      if (!keys.length) return Promise.resolve(bufferResult);

      var ipc = null;
      try {
        if (typeof require !== 'undefined') {
          var electron = require('electron');
          ipc = electron && electron.ipcRenderer;
        }
      } catch (e) {}

      if (!ipc || typeof ipc.invoke !== 'function') return Promise.resolve(bufferResult);

      var merged = bufferResult;
      var chain = Promise.resolve();
      keys.forEach(function (key) {
        chain = chain.then(function () {
          return ipc.invoke('getMemoryCacheData', key).then(function (result) {
            var block = parseMemoryCachePayload(result, key, resolveApiNameFromKey(key));
            if (block.conversationCount > merged.conversationCount) merged = block;
          }).catch(function () {});
        });
      });
      return chain.then(function () { return merged; });
    }

    function scoreLeftListArea(rect, viewport) {
      var score = 0;
      if (rect.x <= (viewport.width || 1200) * 0.4) score += 20;
      if (rect.width >= 180 && rect.width <= 450) score += 15;
      if (rect.height >= 300) score += 10;
      if (rect.height >= 500) score += 10;
      return score;
    }

    function scanDomGeometryConversationList() {
      var viewport = getViewport();
      var leftBound = (viewport.width || 1200) * 0.4;
      var listArea = { selectorPath: '', rect: {}, score: 0 };
      var items = [];
      var seen = Object.create(null);

      try {
        var areas = document.querySelectorAll('div, section, ul');
        for (var ai = 0; ai < areas.length && ai < 300; ai++) {
          var area = areas[ai];
          if (!area || area.offsetParent === null) continue;
          var aRect = getRect(area);
          var aScore = scoreLeftListArea(aRect, viewport);
          if (aScore > listArea.score) {
            listArea = { selectorPath: buildSelectorPath(area, 4), rect: aRect, score: aScore };
          }
        }

        var nodes = document.querySelectorAll('div, li');
        for (var i = 0; i < nodes.length && items.length < 30; i++) {
          var el = nodes[i];
          if (!el || el.offsetParent === null) continue;
          var rect = getRect(el);
          if (rect.x > leftBound) continue;
          if (rect.height < 28 || rect.height > 220 || rect.width < 120 || rect.width > 500) continue;
          var raw = safeString(el.innerText || el.textContent).trim();
          var lines = raw.split(/\\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
          if (!lines.length || lines[0].length < 1 || BLOCKED_BUYER_LABELS.test(lines[0]) || /暂无接待|全店数据|暂无会话|您今日暂无|前往查看/.test(lines[0])) continue;
          var buyerName = lines[0];
          var timeText = '';
          var lastMessage = '';
          for (var li = lines.length - 1; li >= 1; li--) {
            var part = lines[li];
            if (!timeText && (/^\\d{1,2}:\\d{2}/.test(part) || /昨天|今天|前天/.test(part))) timeText = part;
            else if (!lastMessage && part !== buyerName) lastMessage = part;
          }
          var key = buyerName + ':' + rect.height;
          if (seen[key]) continue;
          seen[key] = 1;
          var selected = isSessionItemSelected(el);
          var score = 10;
          if (selected) score += 20;
          if (timeText) score += 5;
          if (lastMessage) score += 5;
          items.push({
            index: items.length,
            buyerName: maskSensitiveText(buyerName).slice(0, 60),
            buyerId: '',
            conversationId: '',
            lastMessage: maskSensitiveText(lastMessage).slice(0, 120),
            timeText: maskSensitiveText(timeText).slice(0, 40),
            selected: selected,
            selectorPath: buildSelectorPath(el, 4),
            rect: rect,
            score: score,
            source: 'dom_geometry'
          });
        }
      } catch (e) {}

      items.sort(function (a, b) {
        if (a.selected && !b.selected) return -1;
        if (!a.selected && b.selected) return 1;
        return (b.score || 0) - (a.score || 0);
      });

      return {
        source: 'dom_geometry',
        listArea: listArea,
        itemCount: items.length,
        items: items.slice(0, 20)
      };
    }

    function readTopChatTitle() {
      var out = { buyerName: '', selectorPath: '', rect: {} };
      try {
        var viewport = getViewport();
        var selectors = [
          '[class*="chat-header"]', '[class*="conversation-header"]', '[class*="session-header"]',
          '[class*="title-bar"] h1', '[class*="title-bar"] h2', '[class*="title-bar"] span',
          '[class*="header"] [class*="name"]', '[class*="header"] [class*="title"]',
          '[class*="nick"]', '[class*="nickname"]', '[class*="user-name"]'
        ];
        for (var si = 0; si < selectors.length; si++) {
          var el = document.querySelector(selectors[si]);
          if (!el) continue;
          var text = safeString(el.innerText || el.textContent).trim().split('\\n')[0];
          if (!text || text.length > 80 || BLOCKED_BUYER_LABELS.test(text) || isUiNoise(text)) continue;
          if (/暂无|请选择|接待数据|全店数据/.test(text)) continue;
          out.buyerName = maskSensitiveText(text).slice(0, 60);
          out.selectorPath = buildSelectorPath(el, 4);
          out.rect = getRect(el);
          return out;
        }
        var nodes = document.querySelectorAll('div, span, h1, h2, h3');
        for (var i = 0; i < nodes.length && i < 600; i++) {
          var node = nodes[i];
          if (!node || node.offsetParent === null) continue;
          var rect = getRect(node);
          if (rect.y > 150 || rect.x < viewport.width * 0.22 || rect.x > viewport.width * 0.78) continue;
          if (rect.width < 24 || rect.height < 14 || rect.height > 56) continue;
          var line = safeString(node.innerText || node.textContent).trim().split('\\n')[0];
          if (!line || line.length < 2 || line.length > 40) continue;
          if (BLOCKED_BUYER_LABELS.test(line) || isUiNoise(line) || /暂无|请选择|接待数据|全店数据/.test(line)) continue;
          out.buyerName = maskSensitiveText(line).slice(0, 60);
          out.selectorPath = buildSelectorPath(node, 4);
          out.rect = rect;
          break;
        }
      } catch (e) {}
      return out;
    }

    function readRightProfileBuyer() {
      var out = { buyerId: '', buyerName: '', selectorPath: '', rect: {} };
      try {
        var viewport = getViewport();
        var selectors = [
          '[class*="customer-profile"]', '[class*="customer-info"]', '[class*="profile-panel"]',
          '[class*="buyer-profile"]', '[class*="user-profile"]'
        ];
        for (var i = 0; i < selectors.length; i++) {
          var el = document.querySelector(selectors[i]);
          if (!el || el.offsetParent === null) continue;
          var rect = getRect(el);
          if (rect.x < viewport.width * 0.55) continue;
          var pid = pickFirst(
            el.getAttribute('data-user-id'), el.getAttribute('data-buyer-id'), el.getAttribute('data-uid')
          );
          var text = safeString(el.innerText || el.textContent).trim().split('\\n')[0];
          if (pid && !/conv|session/i.test(pid)) out.buyerId = maskValue(pid);
          if (text && text.length > 1 && text.length < 80 && !BLOCKED_BUYER_LABELS.test(text)) {
            out.buyerName = maskSensitiveText(text).slice(0, 60);
          }
          out.selectorPath = buildSelectorPath(el, 4);
          out.rect = rect;
          if (out.buyerId || out.buyerName) break;
        }
      } catch (e) {}
      return out;
    }

    function resolveSelectedConversationFallback(memoryCache, reactFiber, domList) {
      var hints = typeof readActiveConversationHints === 'function' ? readActiveConversationHints() : {};
      var topTitle = readTopChatTitle();
      var rightProfile = readRightProfileBuyer();
      var sources = [];
      var buyerId = '';
      var buyerName = '';
      var conversationId = '';
      var buyerIdSource = '';
      var buyerNameSource = '';
      var conversationIdSource = '';
      var confidence = 0;

      function applyField(field, value, source, weight) {
        if (!value) return;
        if (field === 'buyerId' && !buyerId) { buyerId = value; buyerIdSource = source; confidence += weight; sources.push(source); }
        if (field === 'buyerName' && !buyerName) { buyerName = value; buyerNameSource = source; confidence += weight; sources.push(source); }
        if (field === 'conversationId' && !conversationId) { conversationId = value; conversationIdSource = source; confidence += weight; sources.push(source); }
      }

      applyField('buyerName', hints.chatHeaderBuyerName, 'chat_header', 25);
      applyField('buyerName', hints.sessionListBuyerName, 'session_list_item', 22);
      applyField('buyerName', hints.buyerName, hints.buyerNameSource || 'selected_conversation', 20);
      applyField('buyerId', hints.buyerId, hints.buyerIdSource || 'chat_area', 18);
      applyField('buyerId', hints.profileBuyerId, 'customer_profile', 16);
      applyField('conversationId', hints.conversationId, hints.conversationIdSource || 'selected_conversation', 15);
      applyField('buyerName', topTitle.buyerName, 'top_title', 24);
      applyField('buyerName', rightProfile.buyerName, 'right_profile', 20);
      applyField('buyerId', rightProfile.buyerId, 'right_profile', 18);

      var mcSel = memoryCache && memoryCache.selectedConversation;
      if (mcSel) {
        applyField('buyerName', mcSel.buyerName, 'memory_cache', 28);
        applyField('buyerId', mcSel.buyerId, 'memory_cache', 26);
        applyField('conversationId', mcSel.conversationId, 'memory_cache', 24);
      }

      var fiberSel = reactFiber && reactFiber.selectedConversation;
      if (fiberSel && (fiberSel.buyerName || fiberSel.buyerId)) {
        applyField('buyerName', fiberSel.buyerName, 'react_fiber', 22);
        applyField('buyerId', fiberSel.buyerId, 'react_fiber', 20);
        applyField('conversationId', fiberSel.conversationId, 'react_fiber', 18);
      }

      if (domList && domList.items) {
        for (var di = 0; di < domList.items.length; di++) {
          if (!domList.items[di].selected) continue;
          applyField('buyerName', domList.items[di].buyerName, 'dom_geometry_active', 21);
          applyField('buyerId', domList.items[di].buyerId, 'dom_geometry_active', 19);
          applyField('conversationId', domList.items[di].conversationId, 'dom_geometry_active', 17);
          break;
        }
      }

      var detected = !!(buyerName || (buyerId && safeString(buyerId).length >= 10));
      return {
        selectedConversationDetected: detected,
        buyerId: maskValue(buyerId),
        buyerName: maskSensitiveText(buyerName).slice(0, 60),
        conversationId: maskValue(conversationId),
        conversationIdSource: conversationIdSource,
        buyerNameSource: buyerNameSource,
        buyerIdSource: buyerIdSource,
        confidence: Math.min(100, confidence),
        sources: sources,
        topTitle: topTitle,
        rightProfile: rightProfile,
        messageArea: { hints: hints }
      };
    }

    function buildSourcesSummary(payload) {
      var mc = payload.memoryCache || {};
      var rf = payload.reactFiber || {};
      var dom = payload.domList || {};
      var sel = payload.selectedConversation || {};
      var convCount = Math.max(
        mc.conversationCount || 0,
        (rf.conversations || []).length,
        dom.itemCount || (dom.items || []).length
      );
      return {
        conversationListCaptured: convCount > 0,
        memoryCacheCount: mc.conversationCount || 0,
        reactFiberCount: rf.conversationLikeObjectCount || (rf.conversations || []).length,
        domGeometryCount: dom.itemCount || (dom.items || []).length,
        selectedConversationDetected: !!sel.selectedConversationDetected,
        selectedConfidence: sel.confidence || 0,
        primaryListSource: (mc.conversationCount > 0) ? 'memory_cache' : ((rf.conversations || []).length > 0 ? 'react_fiber' : ((dom.items || []).length > 0 ? 'dom_geometry' : 'none')),
        sendAllowedBySelectedConversation: !!sel.selectedConversationDetected && !!(sel.buyerName || sel.buyerId)
      };
    }

    function mergeSourcesToConversationList(payload) {
      var merged = [];
      var seen = Object.create(null);
      var order = [
        { block: payload.memoryCache, field: 'conversations' },
        { block: payload.reactFiber, field: 'conversations' },
        { block: payload.domList, field: 'items' }
      ];
      order.forEach(function (entry) {
        var rows = (entry.block && entry.block[entry.field]) || [];
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          var norm = normalizeConvRow(row, row.source || entry.block.source, !!row.selected);
          if (!norm) continue;
          var key = (norm.conversationId || '') + ':' + (norm.buyerId || '') + ':' + (norm.buyerName || '');
          if (seen[key]) continue;
          seen[key] = 1;
          merged.push({
            index: merged.length,
            buyerId: norm.buyerId,
            buyerName: norm.buyerName,
            conversationId: norm.conversationId,
            lastMessage: norm.lastMessage,
            timeText: norm.timeText,
            selected: norm.selected,
            source: norm.source
          });
        }
      });
      var selected = payload.selectedConversation || {};
      if (!merged.length && (selected.buyerName || selected.buyerId)) {
        merged.push({
          index: 0,
          buyerId: selected.buyerId || '',
          buyerName: selected.buyerName || '',
          conversationId: selected.conversationId || '',
          lastMessage: '',
          timeText: '',
          selected: true,
          source: 'selected_fallback'
        });
      }
      var selectedConversation = {
        buyerId: selected.buyerId || '',
        buyerName: selected.buyerName || '',
        conversationId: selected.conversationId || '',
        lastMessage: '',
        selected: true,
        buyerNameSource: selected.buyerNameSource || '',
        conversationIdSource: selected.conversationIdSource || ''
      };
      for (var si = 0; si < merged.length; si++) {
        if (merged[si].selected) {
          selectedConversation = Object.assign({}, merged[si], { selected: true });
          break;
        }
      }
      if (!selectedConversation.buyerName && !selectedConversation.buyerId && merged.length) {
        selectedConversation = Object.assign({}, merged[0], { selected: true });
      }
      return { conversations: merged, selectedConversation: selectedConversation, count: merged.length };
    }

    function inspectConversationSources(options) {
      options = options || {};
      var page = getPageInfo();
      if (!page.isImWorkspace) {
        send('bridge.log', { command: 'debug.inspect_conversation_sources', success: false, reason: 'not_im_page' });
        return Promise.resolve(null);
      }

      var reactFiber = scanReactFiberConversations();
      var domList = scanDomGeometryConversationList();
      var memoryCache = scanNetworkBufferForConversations();

      return probeMemoryCacheConversationsAsync().then(function (mc) {
        if ((mc.conversationCount || 0) >= (memoryCache.conversationCount || 0)) memoryCache = mc;
        var selectedConversation = resolveSelectedConversationFallback(memoryCache, reactFiber, domList);
        var payload = {
          success: true,
          reason: 'conversation_sources_inspected',
          bridgeId: bridgeId,
          href: page.href,
          shopInfo: {
            shopId: shopCache.shopId || '',
            shopName: shopCache.shopName || '',
            sessionPartitionKey: shopCache.sessionPartitionKey || '',
          },
          memoryCache: memoryCache,
          reactFiber: reactFiber,
          domList: domList,
          selectedConversation: selectedConversation,
          topTitle: selectedConversation.topTitle || {},
          rightProfile: selectedConversation.rightProfile || {},
          messageArea: selectedConversation.messageArea || {},
          summary: {}
        };
        payload.summary = buildSourcesSummary(payload);
        send('doudian.conversation.sources_inspection', payload);

        if (options.emitListCaptured) {
          var merged = mergeSourcesToConversationList(payload);
          send('doudian.conversation.list_captured', {
            success: true,
            reason: 'conversation_list_captured',
            bridgeId: bridgeId,
            href: page.href,
            shopInfo: payload.shopInfo,
            selectedConversation: merged.selectedConversation,
            conversations: merged.conversations,
            count: merged.count,
            sourcesSummary: payload.summary,
            multiSource: true
          });
        }
        return payload;
      });
    }
`;
}

module.exports = {
  buildConversationSourcesBrowserCode,
};
