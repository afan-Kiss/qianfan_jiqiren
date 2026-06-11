/**
 * 浏览器端：读取当前聊天区域历史消息（分区诊断 + 窄选择器）
 */
function buildChatHistoryBrowserCode() {
  return `
    var CHAT_BUBBLE_ROOT_SELECTORS = [
      '[class*="message-list"]', '[class*="msg-list"]', '[class*="chat-content"]',
      '[class*="im-chat"][class*="content"]', '[class*="conversation-detail"]',
      '#chatScrollArea', '#messageList'
    ];
    var BUBBLE_ITEM_SELECTORS = [
      '[class*="message-item"]', '[class*="msg-item"]', '[class*="im-msg"]',
      '[class*="bubble"]', '[class*="chat-bubble"]'
    ];
    var EXCLUDE_ANCESTOR_RE = /sidebar|side-bar|sidepanel|side-panel|profile|customer-info|customer-profile|quick-phrase|phrase-list|shortcut|remark|input-area|editor-area|toolbar|nav-bar|conversation-list|session-list|order-card|product-card|goods-card|shop-card|header-bar/i;
    var CHAT_HEADER_SELECTORS = [
      '[class*="chat-header"]', '[class*="conversation-header"]',
      '[class*="session-header"]', '[class*="buyer-name"]', '[class*="user-name"]'
    ];
    var BLOCKED_BUYER_LABELS = /^(个人短语|团队短语|快捷短语|接待工具|添加备注|客户资料|商家后台|AI智能客服|当前会话|最近联系|在线|三方|更多|店铺消费|抖音-商品详情页|消息|会话|搜索|实时|飞鸽客服系统)$/;
    var UI_TEXT_RE = /拖拽到此发送|添加备注|店铺消费|抖音-商品详情页|个人短语|团队短语|快捷短语|接待工具|客户资料|客户画像|商品详情|自营旗舰店/;

    function classifyDomArea(el) {
      if (!el) return 'unknownArea';
      try {
        var node = el;
        for (var depth = 0; node && depth < 8; depth++) {
          var cls = safeString(node.className).toLowerCase();
          var id = safeString(node.id).toLowerCase();
          var hint = cls + ' ' + id;
          if (/quick-phrase|phrase-list|shortcut|personal-phrase|team-phrase/.test(hint)) return 'quickPhraseArea';
          if (/customer-profile|customer-info|profile-panel|buyer-profile|user-profile/.test(hint)) return 'customerProfileArea';
          if (/order-card|product-card|goods-card|shop-card|commodity/.test(hint)) return 'orderCardArea';
          if (/input-area|editor-area|send-box|textarea|composer|toolbar/.test(hint)) return 'inputArea';
          if (/message-list|msg-list|chat-content|chat-main|conversation-detail|chat-scroll/.test(hint)) return 'chatBubbleArea';
          node = node.parentElement;
        }
      } catch (e) {}
      return 'unknownArea';
    }

    function isExcludedAncestor(el) {
      if (!el) return true;
      try {
        var node = el;
        for (var depth = 0; node && depth < 10; depth++) {
          var cls = safeString(node.className);
          var id = safeString(node.id);
          if (EXCLUDE_ANCESTOR_RE.test(cls) || EXCLUDE_ANCESTOR_RE.test(id)) return true;
          node = node.parentElement;
        }
      } catch (e) {}
      return false;
    }

    function detectMessageType(text, el) {
      var t = safeString(text).toLowerCase();
      try {
        if (el && el.querySelector && el.querySelector('img,svg image,[class*="image"],[class*="pic"]')) return 'image';
      } catch (e) {}
      if (/售后|退款|退货|换货/.test(t)) return 'aftersale_card';
      if (/订单|下单|商品|物流|快递/.test(t)) return 'order_card';
      if (/系统消息|自动回复|机器人/.test(t)) return 'system';
      if (t) return 'text';
      return 'unknown';
    }

    function detectAvatarSide(el) {
      if (!el) return 'unknown';
      try {
        var parent = el.parentElement;
        if (!parent) return 'unknown';
        var imgs = parent.querySelectorAll('img, [class*="avatar"], [class*="head"]');
        if (!imgs || !imgs.length) return 'unknown';
        var bubbleRect = el.getBoundingClientRect();
        var bubbleCx = bubbleRect.x + bubbleRect.width / 2;
        for (var ai = 0; ai < imgs.length; ai++) {
          var av = imgs[ai];
          if (!av || av.offsetParent === null) continue;
          var avRect = av.getBoundingClientRect();
          var avCx = avRect.x + avRect.width / 2;
          if (avCx < bubbleCx - 10) return 'left';
          if (avCx > bubbleCx + 10) return 'right';
        }
      } catch (e) {}
      return 'unknown';
    }

    function resolveBubbleDirection(el, messageAreaCenterX) {
      if (!el) return { directionGuess: 'unknown', directionConfidence: 0, directionReasons: [] };
      var rect = el.getBoundingClientRect();
      var bubbleCenterX = rect.x + rect.width / 2;
      var centerX = messageAreaCenterX || (window.innerWidth * 0.55);
      var text = safeString(el.innerText || el.textContent).trim();
      var classChain = '';
      try {
        var node = el;
        for (var d = 0; node && d < 5; d++) {
          classChain += ' ' + safeString(node.className).toLowerCase();
          node = node.parentElement;
        }
      } catch (e) {}
      var directionGuess = 'unknown';
      var directionConfidence = 0;
      var directionReasons = [];
      var isLeftBubble = false;
      var isRightBubble = false;
      var avatarSide = detectAvatarSide(el);

      if (bubbleCenterX < centerX - 30) {
        isLeftBubble = true;
        directionGuess = 'buyer';
        directionConfidence += 35;
        directionReasons.push('position_left');
      } else if (bubbleCenterX > centerX + 30) {
        isRightBubble = true;
        directionGuess = 'seller';
        directionConfidence += 35;
        directionReasons.push('position_right');
      }
      if (/self|mine|right|sender|service|seller|staff|kefu|outbound|send|is-self|from-self|merchant|shop-msg/.test(classChain)) {
        directionGuess = 'seller';
        directionConfidence += 20;
        directionReasons.push('class_seller');
      }
      if (/left|buyer|user|customer|consumer|inbound|receive|guest|is-buyer|from-user|visitor/.test(classChain)) {
        directionGuess = 'buyer';
        directionConfidence += 20;
        directionReasons.push('class_buyer');
      }
      if (avatarSide === 'left') {
        directionGuess = 'buyer';
        directionConfidence += 15;
        directionReasons.push('avatar_left');
      } else if (avatarSide === 'right') {
        directionGuess = 'seller';
        directionConfidence += 15;
        directionReasons.push('avatar_right');
      }
      if (/您好，现在是人工客服为您服务|亲亲，很高兴为您服务|请问需要什么帮助|在的，请问|客服.*为您服务|商家配置发送/.test(text)) {
        directionGuess = 'seller';
        directionConfidence += 25;
        directionReasons.push('phrase_seller');
      } else if (/^在在在$|^转人工$|^你好$|^5555$|^你还敢$|还有货吗|在吗/.test(text)) {
        directionGuess = 'buyer';
        directionConfidence += 25;
        directionReasons.push('phrase_buyer');
      }
      if (directionConfidence > 100) directionConfidence = 100;
      return {
        directionGuess: directionGuess,
        directionConfidence: directionConfidence,
        directionReasons: directionReasons,
        bubbleCenterX: Math.round(bubbleCenterX),
        messageAreaCenterX: Math.round(centerX),
        isLeftBubble: isLeftBubble,
        isRightBubble: isRightBubble,
        avatarSide: avatarSide,
        classHints: []
      };
    }

    function detectDirection(el) {
      return resolveBubbleDirection(el, 0).directionGuess;
    }

    function readActiveConversationHints() {
      var out = {
        conversationId: '',
        conversationIdSource: '',
        buyerId: '',
        buyerIdSource: '',
        buyerName: '',
        buyerNameSource: '',
        chatHeaderBuyerName: '',
        sessionListBuyerName: '',
        profileBuyerId: ''
      };
      try {
        for (var hi = 0; hi < CHAT_HEADER_SELECTORS.length; hi++) {
          var header = document.querySelector(CHAT_HEADER_SELECTORS[hi]);
          if (!header) continue;
          var ht = safeString(header.innerText || header.textContent).trim().split('\\n')[0];
          if (ht && ht.length < 80 && !BLOCKED_BUYER_LABELS.test(ht)) {
            out.buyerName = maskSensitiveText(ht.slice(0, 60));
            out.chatHeaderBuyerName = out.buyerName;
            out.buyerNameSource = 'chat_header';
            break;
          }
        }

        var chatAreaSelectors = [
          'div.messageList', '[class*="message-list"]', '[class*="chat-content"]',
          '[class*="conversation-detail"]', '[class*="im-chat"]', '[class*="chat-main"]'
        ];
        for (var ci = 0; ci < chatAreaSelectors.length; ci++) {
          var chatEl = document.querySelector(chatAreaSelectors[ci]);
          if (!chatEl) continue;
          var chatBid = pickFirst(
            chatEl.getAttribute('data-user-id'),
            chatEl.getAttribute('data-buyer-id'),
            chatEl.getAttribute('data-uid')
          );
          if (chatBid && !/conv|session/i.test(chatBid)) {
            out.buyerId = chatBid;
            out.buyerIdSource = 'chat_area';
            break;
          }
        }

        var profileSelectors = [
          '[class*="customer-profile"]', '[class*="customer-info"]', '[class*="profile-panel"]',
          '[class*="buyer-profile"]', '[class*="user-profile"]'
        ];
        for (var pi = 0; pi < profileSelectors.length; pi++) {
          var profile = document.querySelector(profileSelectors[pi]);
          if (!profile) continue;
          var pid = pickFirst(
            profile.getAttribute('data-user-id'),
            profile.getAttribute('data-buyer-id'),
            profile.getAttribute('data-uid')
          );
          if (!pid) {
            var pchild = profile.querySelector('[data-user-id],[data-buyer-id],[data-uid]');
            if (pchild) {
              pid = pickFirst(
                pchild.getAttribute('data-user-id'),
                pchild.getAttribute('data-buyer-id'),
                pchild.getAttribute('data-uid')
              );
            }
          }
          if (pid && !/conv|session/i.test(pid)) {
            out.profileBuyerId = pid;
            if (!out.buyerId) {
              out.buyerId = pid;
              out.buyerIdSource = 'customer_profile';
            }
            break;
          }
        }

        var selectedItem = document.querySelector(
          '[class*="conversation-list"] [class*="active"], [class*="session-list"] [class*="active"], [class*="conv-list"] [class*="selected"], [class*="conversation-item"][class*="active"]'
        );
        if (selectedItem) {
          if (!out.buyerName) {
            var itemText = safeString(selectedItem.innerText || selectedItem.textContent).trim().split('\\n')[0];
            if (itemText && itemText.length < 80 && !BLOCKED_BUYER_LABELS.test(itemText)) {
              out.buyerName = maskSensitiveText(itemText.slice(0, 60));
              out.sessionListBuyerName = out.buyerName;
              out.buyerNameSource = 'session_list_item';
            }
          }
          var itemConv = pickFirst(
            selectedItem.getAttribute('data-conversation-id'),
            selectedItem.getAttribute('data-session-id'),
            selectedItem.getAttribute('data-user-id')
          );
          if (itemConv) {
            if (/conv|session/i.test(itemConv)) {
              out.conversationId = itemConv;
              out.conversationIdSource = 'session_list_item';
            } else if (!out.buyerId) {
              out.buyerId = itemConv;
              out.buyerIdSource = 'session_list_item';
            }
          }
        }
      } catch (e) {}
      return out;
    }

    function findChatBubbleRoot() {
      for (var i = 0; i < CHAT_BUBBLE_ROOT_SELECTORS.length; i++) {
        try {
          var nodes = document.querySelectorAll(CHAT_BUBBLE_ROOT_SELECTORS[i]);
          for (var j = 0; j < nodes.length; j++) {
            var el = nodes[j];
            if (isExcludedAncestor(el)) continue;
            if (classifyDomArea(el) !== 'chatBubbleArea') continue;
            var textLen = safeString(el.innerText || el.textContent).length;
            if (textLen > 20 && textLen < 20000) return el;
          }
        } catch (e) {}
      }
      return null;
    }

    function emptyAreaSummary() {
      return { itemCount: 0, sampleTexts: [] };
    }

    function readCurrentChatHistory() {
      var page = getPageInfo();
      if (!page.isImWorkspace) {
        send('bridge.log', { command: 'debug.read_current_chat_history', success: false, reason: 'not_im_page' });
        return;
      }

      var hints = readActiveConversationHints();
      var root = findChatBubbleRoot();
      var domAreas = {
        chatBubbleArea: emptyAreaSummary(),
        customerProfileArea: emptyAreaSummary(),
        quickPhraseArea: emptyAreaSummary(),
        orderCardArea: emptyAreaSummary(),
        inputArea: emptyAreaSummary(),
        unknownArea: emptyAreaSummary(),
      };
      var items = [];
      var seen = Object.create(null);

      function pushAreaSample(area, text) {
        var summary = domAreas[area] || domAreas.unknownArea;
        summary.itemCount += 1;
        if (summary.sampleTexts.length < 3) summary.sampleTexts.push(maskSensitiveText(text).slice(0, 120));
      }

      if (root) {
        try {
          var rootRect = root.getBoundingClientRect();
          var messageAreaCenterX = rootRect.x + rootRect.width / 2;
          var bubbleNodes = [];
          for (var si = 0; si < BUBBLE_ITEM_SELECTORS.length; si++) {
            var found = root.querySelectorAll(BUBBLE_ITEM_SELECTORS[si]);
            for (var fi = 0; fi < found.length; fi++) bubbleNodes.push(found[fi]);
          }
          for (var bi = 0; bi < bubbleNodes.length && bi < 300; bi++) {
            var bubble = bubbleNodes[bi];
            if (!bubble || bubble.children.length > 10) continue;
            if (isExcludedAncestor(bubble)) continue;
            var area = classifyDomArea(bubble);
            var raw = safeString(bubble.innerText || bubble.textContent).trim();
            if (raw.length < 1 || raw.length > 1000) continue;
            if (isUiNoise(raw) || UI_TEXT_RE.test(raw)) {
              pushAreaSample(area, raw);
              continue;
            }
            if (/^(发送|确定|取消|更多|图片|表情|订单|售后)$/.test(raw)) {
              pushAreaSample(area, raw);
              continue;
            }
            pushAreaSample(area, raw);
            if (area !== 'chatBubbleArea') continue;
            var dirInfo = resolveBubbleDirection(bubble, messageAreaCenterX);
            var key = hashText(raw.slice(0, 200) + ':' + dirInfo.directionGuess);
            if (seen[key]) continue;
            seen[key] = 1;
            items.push({
              messageId: '',
              direction: dirInfo.directionGuess,
              directionConfidence: dirInfo.directionConfidence,
              directionReasons: dirInfo.directionReasons,
              messageType: detectMessageType(raw, bubble),
              text: maskSensitiveText(raw).slice(0, 1000),
              timestamp: Date.now() - (items.length * 1000),
              domArea: 'chatBubbleArea',
              bubbleTrusted: true,
              messageAreaTrusted: true,
            });
          }
        } catch (e) {}
      }

      send('doudian.chat.history_snapshot', {
        shopInfo: {
          shopId: shopCache.shopId || '',
          shopName: shopCache.shopName || '',
          sessionPartitionKey: shopCache.sessionPartitionKey || '',
          accountId: maskValue(shopCache.accountId || ''),
          shopIdentitySource: shopCache.shopIdentitySource || 'bridge_cache',
        },
        conversationId: hints.conversationId,
        buyerId: hints.buyerId,
        buyerName: hints.buyerName,
        source: 'dom',
        messageCount: items.length,
        items: items,
        domAreas: domAreas,
        chatBubbleCandidateCount: domAreas.chatBubbleArea.itemCount,
        sidePanelCandidateCount:
          domAreas.customerProfileArea.itemCount +
          domAreas.quickPhraseArea.itemCount +
          domAreas.orderCardArea.itemCount +
          domAreas.inputArea.itemCount +
          domAreas.unknownArea.itemCount,
        href: page.href,
        bridgeId: bridgeId,
      });
    }
`;
}

module.exports = {
  buildChatHistoryBrowserCode,
};
