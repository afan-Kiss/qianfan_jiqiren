/**
 * 浏览器端：聊天 DOM 结构诊断 + 两阶段历史读取
 */
function buildChatDomInspectionCode() {
  return `
    var AREA_PROBE_SELECTORS = [
      '[class*="message"]', '[class*="msg"]', '[class*="bubble"]', '[class*="chat"]',
      '[class*="conversation"]', '[class*="im"]', '[class*="content"]', '[class*="scroll"]',
      '[class*="list"]', '[data-e2e*="message"]', '[data-e2e*="chat"]',
      '[data-testid*="message"]', '[data-testid*="chat"]', '[role="list"]', '[role="listitem"]'
    ];
    var EXCLUDE_ZONE_RE = /sidebar|side-bar|sidepanel|profile|customer-info|customer-profile|quick-phrase|phrase-list|shortcut|remark|input-area|editor-area|toolbar|nav-bar|conversation-list|session-list|session-item|conv-list|header-bar|goods-card|product-card|order-card/i;
    var BLOCKED_BUYER_LABELS = /^(个人短语|团队短语|快捷短语|接待工具|添加备注|客户资料|商家后台|AI智能客服|当前会话|最近联系|在线|三方|更多|店铺消费|抖音-商品详情页|消息|会话|搜索|实时|飞鸽客服系统)$/;
    var UI_TEXT_RE = /拖拽到此发送|添加备注|店铺消费|抖音-商品详情页|个人短语|团队短语|快捷短语|接待工具|客户资料|客户画像|商品详情|自营旗舰店/;
    var TIME_TEXT_RE = /(\\d{1,2}:\\d{2}(:\\d{2})?|昨天|今天|前天|\\d{1,2}月\\d{1,2}日)/;

    function getViewport() {
      var w = window.innerWidth || document.documentElement.clientWidth || 0;
      var h = window.innerHeight || document.documentElement.clientHeight || 0;
      return { width: w, height: h };
    }

    function getRect(el) {
      try {
        var r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      } catch (e) { return { x: 0, y: 0, width: 0, height: 0 }; }
    }

    function buildSelectorPath(el, maxDepth) {
      var parts = [];
      var node = el;
      var depth = 0;
      while (node && node.nodeType === 1 && depth < (maxDepth || 6)) {
        var tag = safeString(node.tagName).toLowerCase();
        var id = safeString(node.id);
        var cls = safeString(node.className).split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
        var seg = tag;
        if (id) seg += '#' + id.slice(0, 40);
        else if (cls) seg += '.' + cls.slice(0, 60);
        parts.unshift(seg);
        node = node.parentElement;
        depth++;
      }
      return parts.join(' > ');
    }

    function collectDataAttrs(el) {
      var out = {};
      try {
        if (!el || !el.attributes) return out;
        for (var i = 0; i < el.attributes.length && i < 12; i++) {
          var attr = el.attributes[i];
          if (attr && /^data-/.test(attr.name)) out[attr.name] = safeString(attr.value).slice(0, 80);
        }
      } catch (e) {}
      return out;
    }

    function zoneFromElement(el) {
      if (!el) return 'unknown';
      try {
        var node = el;
        for (var d = 0; node && d < 10; d++) {
          var cls = safeString(node.className).toLowerCase();
          var id = safeString(node.id).toLowerCase();
          var hint = cls + ' ' + id;
          if (/conversation-list|session-list|conv-list/.test(hint)) return 'left_session_list';
          if (/customer-profile|customer-info|profile-panel|buyer-profile/.test(hint)) return 'right_profile';
          if (/quick-phrase|phrase-list|shortcut|personal-phrase/.test(hint)) return 'quick_phrase';
          if (/input-area|editor-area|send-box|textarea|composer/.test(hint)) return 'input_area';
          if (/toolbar|nav-bar|header-bar/.test(hint)) return 'top_nav';
          if (/order-card|product-card|goods-card|shop-card/.test(hint)) return 'order_card';
          node = node.parentElement;
        }
      } catch (e) {}
      return 'center_unknown';
    }

    function isExcludedZone(el) {
      if (!el) return true;
      try {
        var node = el;
        for (var d = 0; node && d < 10; d++) {
          var cls = safeString(node.className);
          var id = safeString(node.id);
          if (EXCLUDE_ZONE_RE.test(cls) || EXCLUDE_ZONE_RE.test(id)) return true;
          node = node.parentElement;
        }
      } catch (e) {}
      return false;
    }

    function scoreMessageArea(el, rect, viewport, text, sampleText) {
      var score = 0;
      var reason = [];
      var zone = zoneFromElement(el);
      if (zone === 'left_session_list' || zone === 'right_profile' || zone === 'quick_phrase' || zone === 'input_area' || zone === 'top_nav') {
        return { score: -50, reason: ['excluded_zone:' + zone], zone: zone };
      }
      if (rect.height >= 200) { score += 10; reason.push('height_ok'); }
      if (el.scrollHeight > el.clientHeight + 20) { score += 12; reason.push('scrollable'); }
      if (text.length >= 30) { score += 8; reason.push('text_density'); }
      if (rect.width >= 200 && rect.width <= 1200) { score += 6; reason.push('width_ok'); }
      var cx = rect.x + rect.width / 2;
      if (viewport.width > 0 && cx > viewport.width * 0.2 && cx < viewport.width * 0.82) {
        score += 10; reason.push('center_x');
      }
      if (TIME_TEXT_RE.test(sampleText)) { score += 10; reason.push('time_text'); }
      if (/message|msg|bubble|chat|conversation|im-content|scroll/.test(safeString(el.className).toLowerCase())) {
        score += 8; reason.push('class_hint');
      }
      return { score: score, reason: reason, zone: zone };
    }

    function detectMessageType(text, el) {
      var t = safeString(text).toLowerCase();
      try {
        if (el && el.querySelector && el.querySelector('img,svg image,[class*="image"],[class*="pic"]')) return 'image';
      } catch (e) {}
      if (/售后|退款|退货|换货/.test(t)) return 'aftersale_card';
      if (/订单|下单|商品|物流|快递/.test(t)) return 'order_card';
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
        var bubbleRect = getRect(el);
        var bubbleCx = bubbleRect.x + bubbleRect.width / 2;
        for (var ai = 0; ai < imgs.length; ai++) {
          var av = imgs[ai];
          if (!av || av.offsetParent === null) continue;
          var avRect = getRect(av);
          var avCx = avRect.x + avRect.width / 2;
          if (avCx < bubbleCx - 10) return 'left';
          if (avCx > bubbleCx + 10) return 'right';
        }
      } catch (e) {}
      return 'unknown';
    }

    function collectClassHints(el) {
      var hints = [];
      try {
        var node = el;
        for (var d = 0; node && d < 5; d++) {
          var cls = safeString(node.className).split(/\\s+/).filter(Boolean);
          for (var ci = 0; ci < cls.length && ci < 6; ci++) hints.push(cls[ci]);
          node = node.parentElement;
        }
      } catch (e) {}
      return hints.slice(0, 8);
    }

    function resolveBubbleDirection(el, messageAreaCenterX, viewport) {
      var rect = getRect(el);
      var bubbleCenterX = rect.x + rect.width / 2;
      var centerX = messageAreaCenterX || (viewport.width * 0.55);
      var text = safeString(el.innerText || el.textContent).trim();
      var classHints = collectClassHints(el);
      var classChain = classHints.join(' ').toLowerCase();
      var avatarSide = detectAvatarSide(el);
      var directionGuess = 'unknown';
      var directionConfidence = 0;
      var directionReasons = [];
      var isLeftBubble = false;
      var isRightBubble = false;

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

      if (/您好，现在是人工客服为您服务|亲亲，很高兴为您服务|请问需要什么帮助|在的，请问|客服.*为您服务|商家配置发送|为了更高效地帮您|查阅一下您和智能客服/.test(text)) {
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
        classHints: classHints
      };
    }

    function detectDirection(el) {
      return resolveBubbleDirection(el, 0, getViewport()).directionGuess;
    }

    function findNearTimeText(el) {
      try {
        var parent = el && el.parentElement;
        if (!parent) return '';
        var txt = safeString(parent.innerText || parent.textContent).slice(0, 500);
        var m = txt.match(TIME_TEXT_RE);
        return m ? m[0] : '';
      } catch (e) { return ''; }
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
        var headerSelectors = [
          '[class*="chat-header"]', '[class*="conversation-header"]',
          '[class*="session-header"] [class*="name"]', '[class*="buyer-name"]', '[class*="user-name"]'
        ];
        for (var hi = 0; hi < headerSelectors.length; hi++) {
          var header = document.querySelector(headerSelectors[hi]);
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
            chatEl.getAttribute('data-uid'),
            chatEl.getAttribute('data-id')
          );
          if (chatBid && !/conv|session/i.test(chatBid)) {
            out.buyerId = chatBid;
            out.buyerIdSource = 'chat_area';
            break;
          }
          var dataChild = chatEl.querySelector('[data-user-id],[data-buyer-id],[data-uid]');
          if (dataChild) {
            chatBid = pickFirst(
              dataChild.getAttribute('data-user-id'),
              dataChild.getAttribute('data-buyer-id'),
              dataChild.getAttribute('data-uid')
            );
            if (chatBid) {
              out.buyerId = chatBid;
              out.buyerIdSource = 'chat_area';
              break;
            }
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
            var pchild = profile.querySelector('[data-user-id],[data-buyer-id],[data-uid],[data-id]');
            if (pchild) {
              pid = pickFirst(
                pchild.getAttribute('data-user-id'),
                pchild.getAttribute('data-buyer-id'),
                pchild.getAttribute('data-uid'),
                pchild.getAttribute('data-id')
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
          '[class*="conversation-list"] [class*="active"], [class*="session-list"] [class*="active"], [class*="conv-list"] [class*="selected"], [class*="conversation-item"][class*="active"], [class*="session-item"][class*="active"]'
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
            selectedItem.getAttribute('data-id'),
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

        if (!out.conversationId && !out.buyerId) {
          var dataEl = document.querySelector('[data-conversation-id],[data-user-id],[data-id]');
          if (dataEl) {
            var dataId = pickFirst(
              dataEl.getAttribute('data-conversation-id'),
              dataEl.getAttribute('data-user-id'),
              dataEl.getAttribute('data-id')
            );
            if (dataId) {
              if (/conv|session/i.test(dataId)) {
                out.conversationId = dataId;
                out.conversationIdSource = 'dom_data_attr';
              } else {
                out.buyerId = dataId;
                out.buyerIdSource = 'dom_data_attr';
              }
            }
          }
        }
      } catch (e) {}
      return out;
    }

    function getConversationHints() {
      var page = getPageInfo();
      if (!page.isImWorkspace) {
        send('bridge.log', { command: 'debug.get_conversation_hints', success: false, reason: 'not_im_page' });
        return null;
      }
      var hints = readActiveConversationHints();
      var payload = {
        shopInfo: {
          shopId: shopCache.shopId || '',
          shopName: shopCache.shopName || '',
          sessionPartitionKey: shopCache.sessionPartitionKey || '',
          accountId: maskValue(shopCache.accountId || ''),
          shopIdentitySource: shopCache.shopIdentitySource || 'bridge_cache',
        },
        bridgeId: bridgeId,
        href: page.href,
        hints: hints,
        selectedConversation: hints,
      };
      send('doudian.chat.conversation_hints', payload);
      return hints;
    }

    function inspectChatDom() {
      var page = getPageInfo();
      if (!page.isImWorkspace) {
        send('bridge.log', { command: 'debug.inspect_chat_dom', success: false, reason: 'not_im_page' });
        return null;
      }

      var viewport = getViewport();
      var hints = readActiveConversationHints();
      var seen = Object.create(null);
      var candidateMessageAreas = [];
      var candidateBubbles = [];
      var excludedAreas = [];
      var scrollContainers = [];
      var textSamples = [];

      function pushUnique(arr, key, item, limit) {
        if (seen[key]) return;
        seen[key] = 1;
        if (arr.length < (limit || 80)) arr.push(item);
      }

      try {
        var all = document.querySelectorAll(AREA_PROBE_SELECTORS.join(','));
        for (var i = 0; i < all.length && i < 500; i++) {
          var el = all[i];
          if (!el || el.offsetParent === null) continue;
          var rect = getRect(el);
          if (rect.width < 20 || rect.height < 20) continue;
          var text = safeString(el.innerText || el.textContent).trim();
          var sampleText = maskSensitiveText(text).slice(0, 300);
          var zone = zoneFromElement(el);
          var excluded = isExcludedZone(el);
          var areaKey = buildSelectorPath(el, 5) + ':' + rect.width + 'x' + rect.height;

          if (el.scrollHeight > el.clientHeight + 10 && rect.height >= 100) {
            pushUnique(scrollContainers, 'sc:' + areaKey, {
              selectorPath: buildSelectorPath(el, 5),
              rect: rect,
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
              zone: zone
            }, 30);
          }

          if (excluded || zone !== 'center_unknown' && zone !== 'center_unknown') {
            if (excluded || /left_session_list|right_profile|quick_phrase|input_area|top_nav|order_card/.test(zone)) {
              if (text.length > 0 && text.length < 500) {
                pushUnique(excludedAreas, 'ex:' + areaKey, {
                  selectorPath: buildSelectorPath(el, 4),
                  zone: zone,
                  sampleText: sampleText.slice(0, 120),
                  rect: rect
                }, 40);
              }
            }
          }

          if (rect.height >= 120 && text.length >= 10) {
            var areaScore = scoreMessageArea(el, rect, viewport, text, sampleText);
            if (areaScore.score > 0) {
              pushUnique(candidateMessageAreas, 'ar:' + areaKey, {
                tag: safeString(el.tagName).toLowerCase(),
                id: safeString(el.id).slice(0, 60),
                className: safeString(el.className).slice(0, 120),
                role: safeString(el.getAttribute('role')),
                ariaLabel: safeString(el.getAttribute('aria-label')).slice(0, 80),
                dataAttrs: collectDataAttrs(el),
                rect: rect,
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                childCount: el.children ? el.children.length : 0,
                textLength: text.length,
                sampleText: sampleText,
                selectorPath: buildSelectorPath(el, 5),
                score: areaScore.score,
                reason: areaScore.reason,
                zone: areaScore.zone
              }, 40);
            }
          }

          if (text.length >= 2 && text.length <= 800 && rect.width >= 30 && rect.height >= 14 && rect.height <= 500) {
            if (!isUiNoise(text) && !UI_TEXT_RE.test(text) && !BLOCKED_BUYER_LABELS.test(text.split('\\n')[0])) {
              var bubbleScore = 10;
              var bubbleReasons = ['candidate'];
              var rejectReason = '';
              if (excluded || /left_session_list|right_profile|quick_phrase|input_area|top_nav/.test(zone)) {
                bubbleScore -= 30;
                rejectReason = 'excluded_zone';
              } else {
                bubbleScore += 8;
                bubbleReasons.push('visible');
              }
              var nearTime = findNearTimeText(el);
              if (nearTime) { bubbleScore += 10; bubbleReasons.push('near_time'); }
              var areaCenterX = rect.x + rect.width / 2;
              if (/message-list|msg-list|chat-content|messageList/.test(safeString(el.className))) {
                areaCenterX = rect.x + rect.width / 2;
              } else {
                areaCenterX = viewport.width * 0.55;
              }
              var dirInfo = resolveBubbleDirection(el, areaCenterX, viewport);
              var dir = dirInfo.directionGuess;
              if (dir !== 'unknown') { bubbleScore += 6; bubbleReasons.push('direction'); }
              if (rect.width >= 40 && rect.width <= 600) { bubbleScore += 5; bubbleReasons.push('bubble_width'); }

              pushUnique(candidateBubbles, 'bb:' + hashText(text.slice(0, 120) + ':' + dir), {
                selectorPath: buildSelectorPath(el, 4),
                parentSelectorPath: buildSelectorPath(el.parentElement, 4),
                text: maskSensitiveText(text).slice(0, 300),
                messageType: detectMessageType(text, el),
                directionGuess: dirInfo.directionGuess,
                directionConfidence: dirInfo.directionConfidence,
                directionReasons: dirInfo.directionReasons,
                bubbleCenterX: dirInfo.bubbleCenterX,
                messageAreaCenterX: dirInfo.messageAreaCenterX,
                isLeftBubble: dirInfo.isLeftBubble,
                isRightBubble: dirInfo.isRightBubble,
                avatarSide: dirInfo.avatarSide,
                classHints: dirInfo.classHints,
                rect: rect,
                nearTimeText: nearTime,
                score: bubbleScore,
                rejectReason: rejectReason,
                zone: zone
              }, 120);
            }
          }

          if (textSamples.length < 20 && text.length >= 8 && text.length <= 200) {
            textSamples.push(maskSensitiveText(text).slice(0, 120));
          }
        }
      } catch (e) {}

      candidateMessageAreas.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
      candidateBubbles.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });

      var inspection = {
        shopInfo: {
          shopId: shopCache.shopId || '',
          shopName: shopCache.shopName || '',
          sessionPartitionKey: shopCache.sessionPartitionKey || '',
          accountId: maskValue(shopCache.accountId || ''),
          shopIdentitySource: shopCache.shopIdentitySource || 'bridge_cache',
        },
        bridgeId: bridgeId,
        href: page.href,
        selectedConversation: hints,
        viewport: viewport,
        scrollContainers: scrollContainers,
        candidateMessageAreas: candidateMessageAreas.slice(0, 25),
        candidateBubbles: candidateBubbles.slice(0, 80),
        excludedAreas: excludedAreas.slice(0, 30),
        textSamples: textSamples.slice(0, 20),
      };

      send('doudian.chat.dom_inspection', inspection);
      return inspection;
    }

    function readCurrentChatHistory() {
      var page = getPageInfo();
      if (!page.isImWorkspace) {
        send('bridge.log', { command: 'debug.read_current_chat_history', success: false, reason: 'not_im_page' });
        return;
      }

      var inspection = inspectChatDom();
      if (!inspection) return;

      var hints = inspection.selectedConversation || readActiveConversationHints();
      var TRUST_AREA = 40;
      var TRUST_BUBBLE = 25;
      var bestArea = null;
      for (var ai = 0; ai < inspection.candidateMessageAreas.length; ai++) {
        if ((inspection.candidateMessageAreas[ai].score || 0) >= TRUST_AREA) {
          bestArea = inspection.candidateMessageAreas[ai];
          break;
        }
      }
      var messageAreaCenterX = bestArea && bestArea.rect
        ? (bestArea.rect.x || 0) + (bestArea.rect.width || 0) / 2
        : (inspection.viewport.width || 0) * 0.55;

      var items = [];
      var trustedBubbleCount = 0;
      var seenMsg = Object.create(null);

      for (var bi = 0; bi < inspection.candidateBubbles.length; bi++) {
        var b = inspection.candidateBubbles[bi];
        var trusted = (b.score || 0) >= TRUST_BUBBLE && !b.rejectReason;
        if (!trusted) continue;
        if (bestArea && b.zone && /left_session_list|right_profile|quick_phrase|input_area|top_nav/.test(b.zone)) continue;
        var key = hashText((b.text || '') + ':' + (b.directionGuess || ''));
        if (seenMsg[key]) continue;
        seenMsg[key] = 1;
        trustedBubbleCount++;
        items.push({
          messageId: '',
          direction: b.directionGuess || 'unknown',
          directionConfidence: b.directionConfidence || 0,
          directionReasons: b.directionReasons || [],
          messageType: b.messageType || 'text',
          text: safeString(b.text).slice(0, 1000),
          timestamp: Date.now() - (items.length * 1000),
          domArea: 'chatBubbleArea',
          domScore: b.score,
          selectorPath: b.selectorPath || '',
          bubbleTrusted: true,
          messageAreaTrusted: Boolean(bestArea),
          trusted: true,
        });
        if (items.length >= 200) break;
      }

      send('doudian.chat.history_snapshot', {
        shopInfo: inspection.shopInfo,
        conversationId: hints.conversationId,
        buyerId: hints.buyerId,
        buyerName: hints.buyerName,
        source: 'dom',
        messageCount: items.length,
        items: items,
        domInspection: {
          candidateMessageAreaCount: inspection.candidateMessageAreas.length,
          candidateBubbleCount: inspection.candidateBubbles.length,
          trustedMessageAreaCount: bestArea ? 1 : 0,
          trustedBubbleCount: trustedBubbleCount,
          bestMessageArea: bestArea,
          bestBubbleSamples: items.slice(0, 10),
        },
        href: page.href,
        bridgeId: bridgeId,
      });
    }
`;
}

module.exports = {
  buildChatDomInspectionCode,
};
