/**
 * 浏览器端：读取 IM 左侧会话列表 + 当前选中会话（不点击、不发送）
 */
function buildConversationListBrowserCode() {
  return `
    function isSessionItemSelected(el) {
      if (!el) return false;
      try {
        var cls = safeString(el.className).toLowerCase();
        if (/active|selected|current|highlight|focus/.test(cls)) return true;
        if (el.getAttribute('aria-selected') === 'true') return true;
        if (el.getAttribute('data-selected') === 'true') return true;
      } catch (e) {}
      return false;
    }

    function parseSessionListLines(el) {
      var raw = safeString(el.innerText || el.textContent).trim();
      var lines = raw.split(/\\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
      return lines;
    }

    function parseSessionListItem(el, index) {
      var lines = parseSessionListLines(el);
      var buyerName = '';
      var lastMessage = '';
      var timeText = '';
      var selected = isSessionItemSelected(el);

      if (lines.length > 0) {
        buyerName = lines[0];
        if (BLOCKED_BUYER_LABELS.test(buyerName)) buyerName = '';
      }

      for (var li = lines.length - 1; li >= 1; li--) {
        var part = lines[li];
        if (TIME_TEXT_RE.test(part) || /^\\d{1,2}:\\d{2}/.test(part) || /昨天|今天|前天/.test(part)) {
          if (!timeText) timeText = part;
        } else if (!lastMessage && part !== buyerName) {
          lastMessage = part;
        }
      }
      if (!lastMessage && lines.length > 1) {
        lastMessage = lines.slice(1).join(' ').replace(timeText, '').trim();
      }

      var buyerId = '';
      var conversationId = '';
      var itemId = pickFirst(
        el.getAttribute('data-conversation-id'),
        el.getAttribute('data-session-id'),
        el.getAttribute('data-user-id'),
        el.getAttribute('data-buyer-id'),
        el.getAttribute('data-uid'),
        el.getAttribute('data-id')
      );
      if (itemId) {
        if (/conv|session/i.test(itemId)) conversationId = itemId;
        else buyerId = itemId;
      }

      return {
        index: index,
        buyerId: maskValue(buyerId),
        buyerName: maskSensitiveText(buyerName).slice(0, 60),
        conversationId: maskValue(conversationId),
        lastMessage: maskSensitiveText(lastMessage).slice(0, 120),
        timeText: maskSensitiveText(timeText).slice(0, 40),
        selected: selected,
        selectorPath: buildSelectorPath(el, 4)
      };
    }

    function collectConversationListFromDom() {
      var conversations = [];
      var seen = Object.create(null);
      var listSelectors = [
        '[class*="session-list"]',
        '[class*="conversation-list"]',
        '[class*="conv-list"]',
        '[class*="chat-list"]',
        '#chatListScrollArea',
        '[data-e2e*="conversation"]'
      ];
      var itemSelectors = [
        '[class*="session-item"]',
        '[class*="conversation-item"]',
        '[class*="conv-item"]',
        '[class*="chat-item"]',
        '[role="listitem"]'
      ];

      var listRoot = null;
      for (var ls = 0; ls < listSelectors.length; ls++) {
        listRoot = document.querySelector(listSelectors[ls]);
        if (listRoot) break;
      }

      var nodes = [];
      if (listRoot) {
        for (var is = 0; is < itemSelectors.length; is++) {
          var found = listRoot.querySelectorAll(itemSelectors[is]);
          if (found && found.length) {
            nodes = found;
            break;
          }
        }
        if (!nodes.length) {
          nodes = listRoot.querySelectorAll('div, li');
        }
      }
      if (!nodes.length) {
        for (var gs = 0; gs < itemSelectors.length; gs++) {
          var globalFound = document.querySelectorAll(itemSelectors[gs]);
          if (globalFound && globalFound.length >= 2) {
            nodes = globalFound;
            break;
          }
        }
      }

      var viewport = getViewport();
      var leftBound = (viewport.width || 1200) * 0.38;

      for (var i = 0; i < nodes.length && conversations.length < 50; i++) {
        var el = nodes[i];
        if (!el || el.offsetParent === null) continue;
        var rect = getRect(el);
        if (rect.height < 24 || rect.height > 250 || rect.width < 60) continue;
        if (!listRoot && rect.x > leftBound) continue;
        var lines = parseSessionListLines(el);
        if (!lines.length || lines[0].length < 1) continue;
        if (BLOCKED_BUYER_LABELS.test(lines[0])) continue;
        var key = lines[0] + ':' + rect.height;
        if (seen[key]) continue;
        seen[key] = 1;
        conversations.push(parseSessionListItem(el, conversations.length));
      }

      conversations.sort(function (a, b) {
        if (a.selected && !b.selected) return -1;
        if (!a.selected && b.selected) return 1;
        return (a.index || 0) - (b.index || 0);
      });
      return conversations;
    }

    function listCurrentConversations() {
      if (typeof inspectConversationSources === 'function') {
        return inspectConversationSources({ emitListCaptured: true });
      }
      var page = getPageInfo();
      if (!page.isImWorkspace) {
        send('bridge.log', { command: 'debug.list_current_conversations', success: false, reason: 'not_im_page' });
        return null;
      }

      var domList = collectConversationListFromDom();
      var hints = typeof readActiveConversationHints === 'function' ? readActiveConversationHints() : {};
      var selectedConversation = {
        buyerId: hints.buyerId || '',
        buyerName: pickFirst(hints.buyerName, hints.chatHeaderBuyerName, hints.sessionListBuyerName) || '',
        conversationId: hints.conversationId || '',
        lastMessage: '',
        selected: true,
        buyerNameSource: hints.buyerNameSource || '',
        conversationIdSource: hints.conversationIdSource || ''
      };

      var selectedFromList = null;
      for (var si = 0; si < domList.length; si++) {
        if (domList[si].selected) {
          selectedFromList = domList[si];
          break;
        }
      }

      if (selectedFromList) {
        if (!selectedConversation.buyerName) selectedConversation.buyerName = selectedFromList.buyerName;
        if (!selectedConversation.buyerId) selectedConversation.buyerId = selectedFromList.buyerId;
        if (!selectedConversation.conversationId) selectedConversation.conversationId = selectedFromList.conversationId;
        if (!selectedConversation.lastMessage) selectedConversation.lastMessage = selectedFromList.lastMessage;
      }

      if (!domList.length && (selectedConversation.buyerName || selectedConversation.buyerId)) {
        domList = [{
          index: 0,
          buyerId: selectedConversation.buyerId || '',
          buyerName: selectedConversation.buyerName || '',
          conversationId: selectedConversation.conversationId || '',
          lastMessage: selectedConversation.lastMessage || '',
          timeText: '',
          selected: true
        }];
      }

      var payload = {
        success: true,
        reason: 'conversation_list_captured',
        bridgeId: bridgeId,
        href: page.href,
        shopInfo: {
          shopId: shopCache.shopId || '',
          shopName: shopCache.shopName || '',
          sessionPartitionKey: shopCache.sessionPartitionKey || '',
        },
        selectedConversation: selectedConversation,
        conversations: domList,
        count: domList.length,
        hints: hints
      };

      send('doudian.conversation.list_captured', payload);
      return payload;
    }
`;
}

module.exports = {
  buildConversationListBrowserCode,
};
