/**
 * 浏览器端：从 React Fiber / props 只读提取会话数据
 */
function buildReactFiberInspectorBrowserCode() {
  return `
    var FIBER_SKIP_KEYS = /cookie|token|csrf|authorization|ticket|sign|x-ms-token|bd-ticket|session-sign|password|secret|header/i;
    var FIBER_CONV_KEYS = {
      buyerId: ['buyerId', 'buyer_id', 'userId', 'user_id', 'uid', 'customerId', 'customer_id'],
      buyerName: ['buyerName', 'nickName', 'nickname', 'name', 'userName', 'user_name'],
      conversationId: ['conversationId', 'conversation_id', 'conversation_short_id', 'convId', 'conv_id'],
      lastMessage: ['lastMessage', 'last_message', 'content', 'text', 'msg', 'message', 'preview'],
      timestamp: ['timestamp', 'lastMessageTime', 'last_message_time', 'sendTime', 'createTime', 'time'],
      unreadCount: ['unreadCount', 'unread_count', 'unread', 'unReadCount']
    };

    function findReactFiberKey(el) {
      if (!el) return '';
      try {
        for (var key in el) {
          if (!Object.prototype.hasOwnProperty.call(el, key)) continue;
          if (/^__reactFiber\\$/.test(key) || /^__reactProps\\$/.test(key) || /^__reactInternalInstance\\$/.test(key)) {
            return key;
          }
        }
      } catch (e) {}
      return '';
    }

    function pickFiberField(obj, names) {
      if (!obj || typeof obj !== 'object') return '';
      for (var i = 0; i < names.length; i++) {
        var v = obj[names[i]];
        if (v == null) continue;
        if (typeof v === 'string' || typeof v === 'number') return safeString(v).slice(0, 500);
      }
      return '';
    }

    function looksLikeConversationObject(obj) {
      if (!obj || typeof obj !== 'object') return false;
      var bid = pickFiberField(obj, FIBER_CONV_KEYS.buyerId);
      var bname = pickFiberField(obj, FIBER_CONV_KEYS.buyerName);
      var cid = pickFiberField(obj, FIBER_CONV_KEYS.conversationId);
      if (!bid && !bname && !cid) return false;
      if (bname && (BLOCKED_BUYER_LABELS.test(bname) || isUiNoise(bname))) return false;
      if (bid && (/llm|proc|worker|bridge|patch|debug|rust|electron|preload/i.test(bid) || bid.length < 10)) return false;
      return true;
    }

    function normalizeFiberConversation(obj, selected) {
      var buyerName = pickFiberField(obj, FIBER_CONV_KEYS.buyerName);
      var buyerId = pickFiberField(obj, FIBER_CONV_KEYS.buyerId);
      var conversationId = pickFiberField(obj, FIBER_CONV_KEYS.conversationId);
      var lastMessage = pickFiberField(obj, FIBER_CONV_KEYS.lastMessage);
      var timeText = pickFiberField(obj, FIBER_CONV_KEYS.timestamp);
      var unreadCount = Number(pickFiberField(obj, FIBER_CONV_KEYS.unreadCount)) || 0;
      if (!buyerName && !buyerId && !conversationId) return null;
      return {
        buyerId: maskValue(buyerId),
        buyerName: maskSensitiveText(buyerName).slice(0, 60),
        conversationId: maskValue(conversationId),
        lastMessage: maskSensitiveText(lastMessage).slice(0, 120),
        timeText: maskSensitiveText(safeString(timeText).slice(0, 40)),
        unreadCount: unreadCount,
        selected: !!selected,
        source: 'react_fiber'
      };
    }

    function walkFiberProps(props, depth, counter, out, seen) {
      if (!props || depth > 5 || counter.n > 2000) return;
      counter.n++;
      if (Array.isArray(props)) {
        for (var ai = 0; ai < props.length && ai < 50; ai++) walkFiberProps(props[ai], depth + 1, counter, out, seen);
        return;
      }
      if (typeof props !== 'object') return;

      if (looksLikeConversationObject(props)) {
        var norm = normalizeFiberConversation(props, !!(props.active || props.selected || props.isActive || props.is_current));
        if (norm) {
          var key = (norm.conversationId || '') + ':' + (norm.buyerId || '') + ':' + (norm.buyerName || '');
          if (!seen[key]) {
            seen[key] = 1;
            out.push(norm);
          }
        }
      }

      for (var k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
        if (FIBER_SKIP_KEYS.test(k)) continue;
        var val = props[k];
        if (val && typeof val === 'object') walkFiberProps(val, depth + 1, counter, out, seen);
      }
    }

    function extractFiberFromElement(el, counter, out, seen) {
      if (!el || counter.n > 2000) return;
      var fiberKey = findReactFiberKey(el);
      if (!fiberKey) return;
      try {
        var fiber = el[fiberKey];
        if (!fiber) return;
        counter.n++;
        if (fiber.memoizedProps) walkFiberProps(fiber.memoizedProps, 0, counter, out, seen);
        if (fiber.pendingProps) walkFiberProps(fiber.pendingProps, 0, counter, out, seen);
        if (fiber.return && fiber.return.memoizedProps) walkFiberProps(fiber.return.memoizedProps, 0, counter, out, seen);
      } catch (e) {}
    }

    function scanReactFiberConversations() {
      var viewport = getViewport();
      var leftBound = (viewport.width || 1200) * 0.42;
      var conversations = [];
      var seen = Object.create(null);
      var counter = { n: 0 };
      var fiberNodeCount = 0;

      try {
        var nodes = document.querySelectorAll('div, li, span, section');
        for (var i = 0; i < nodes.length && counter.n < 2000; i++) {
          var el = nodes[i];
          if (!el || el.offsetParent === null) continue;
          var rect = getRect(el);
          if (rect.x > leftBound) continue;
          if (rect.width < 40 || rect.height < 20) continue;
          if (!findReactFiberKey(el)) continue;
          fiberNodeCount++;
          extractFiberFromElement(el, counter, conversations, seen);
        }
      } catch (e) {}

      conversations.sort(function (a, b) {
        if (a.selected && !b.selected) return -1;
        if (!a.selected && b.selected) return 1;
        return 0;
      });

      var selectedConversation = null;
      for (var si = 0; si < conversations.length; si++) {
        if (conversations[si].selected) {
          selectedConversation = conversations[si];
          break;
        }
      }

      return {
        source: 'react_fiber',
        fiberNodeCount: fiberNodeCount,
        conversationLikeObjectCount: conversations.length,
        conversations: conversations.slice(0, 20),
        selectedConversation: selectedConversation || {}
      };
    }
`;
}

module.exports = {
  buildReactFiberInspectorBrowserCode,
};
