/**
 * 浏览器端：客服输入框 / 发送按钮检测 + 草稿填入（不点击发送）
 */
function buildReplyEditorBrowserCode() {
  return `
    var EDITOR_SELECTORS = [
      'textarea', '[contenteditable="true"]', '[role="textbox"]',
      '[class*="editor"]', '[class*="input"]', '[class*="textarea"]',
      '[class*="composer"]', '[class*="reply"]'
    ];
    var SEND_BUTTON_SELECTORS = [
      'button', '[role="button"]', '[class*="send"]', '[class*="submit"]'
    ];
    var BLOCKED_EDITOR_RE = /search|remark|note|phrase|quick|shortcut|profile|sidebar|goods|product|aftersale|售后|备注|搜索|短语/i;
    var BLOCKED_BUTTON_RE = /转人工|售后|添加备注|发送商品|发送图片|商品卡片|备注|搜索|短语|退款|同意|拒绝/i;

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

    function getRect(el) {
      try {
        var r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      } catch (e) { return { x: 0, y: 0, width: 0, height: 0 }; }
    }

    function zoneFromElement(el) {
      try {
        var node = el;
        for (var d = 0; node && d < 8; d++) {
          var cls = safeString(node.className).toLowerCase();
          var id = safeString(node.id).toLowerCase();
          var hint = cls + ' ' + id;
          if (/search|search-box|search-input/.test(hint)) return 'search';
          if (/remark|note|memo/.test(hint)) return 'remark';
          if (/quick-phrase|phrase-list|shortcut/.test(hint)) return 'quick_phrase';
          if (/goods|product|commodity/.test(hint)) return 'goods_search';
          if (/aftersale|售后/.test(hint)) return 'aftersale';
          if (/composer|editor-area|input-area|send-box|reply-box/.test(hint)) return 'composer';
          node = node.parentElement;
        }
      } catch (e) {}
      return 'unknown';
    }

    function detectEditorType(el) {
      if (!el) return 'unknown';
      var tag = safeString(el.tagName).toLowerCase();
      if (tag === 'textarea') return 'textarea';
      if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return 'contenteditable';
      if (safeString(el.getAttribute('role')).toLowerCase() === 'textbox') return 'textbox';
      return 'unknown';
    }

    function getEditorText(el) {
      if (!el) return '';
      try {
        if (detectEditorType(el) === 'textarea') return safeString(el.value);
        return safeString(el.innerText || el.textContent);
      } catch (e) { return ''; }
    }

    function setNativeValue(el, value) {
      try {
        var tag = safeString(el.tagName).toLowerCase();
        var proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, value);
        else el.value = value;
        return true;
      } catch (e) { return false; }
    }

    function fillEditorElement(el, draftText) {
      if (!el || !draftText) return { ok: false, reason: 'missing_editor_or_text' };
      var type = detectEditorType(el);
      try {
        el.focus();
        if (type === 'textarea' || type === 'textbox') {
          setNativeValue(el, draftText);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (type === 'contenteditable') {
          el.innerText = draftText;
          try {
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: draftText }));
          } catch (e2) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } else {
          setNativeValue(el, draftText);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        var after = getEditorText(el);
        return {
          ok: after === draftText || after.indexOf(draftText) >= 0,
          editorType: type,
          editorTextAfter: maskSensitiveText(after).slice(0, 300),
        };
      } catch (e) {
        return { ok: false, reason: 'fill_failed' };
      }
    }

    function scoreEditorEl(el, rect, viewport) {
      var score = 0;
      var zone = zoneFromElement(el);
      var path = buildSelectorPath(el, 5).toLowerCase();
      var aria = safeString(el.getAttribute('aria-label')).toLowerCase();
      var placeholder = safeString(el.getAttribute('placeholder')).toLowerCase();
      var hint = path + ' ' + aria + ' ' + placeholder;
      if (zone === 'search' || zone === 'remark' || zone === 'quick_phrase' || zone === 'goods_search' || zone === 'aftersale') return { score: -50, zone: zone };
      if (BLOCKED_EDITOR_RE.test(hint)) return { score: -40, zone: zone };
      if (rect.height >= 20 && rect.width >= 100) score += 10;
      if (viewport.height > 0 && rect.y > viewport.height * 0.55) score += 20;
      if (/composer|editor|textarea|reply|input-area|send-box/.test(hint)) score += 15;
      return { score: score, zone: zone };
    }

    function isInsideComposer(el) {
      try {
        var node = el;
        for (var d = 0; node && d < 10; d++) {
          var id = safeString(node.id).toLowerCase();
          var cls = safeString(node.className).toLowerCase();
          if (id === 'im-input-box' || /composer|input-area|send-box|reply-box/.test(cls + ' ' + id)) return true;
          node = node.parentElement;
        }
      } catch (e) {}
      return false;
    }

    function scoreSendButtonEl(el, rect, viewport, editorRect) {
      var text = normalizeEditorButtonText(el);
      var score = 0;
      if (BLOCKED_BUTTON_RE.test(text)) return { score: -50, text: text };
      if (/^发送$|^send$/i.test(text)) score += 25;
      else if (/发送/.test(text) && text.length <= 8) score += 18;
      else if (/send|submit/.test(safeString(el.className).toLowerCase())) score += 10;
      else if (isInsideComposer(el)) score += 5;
      else return { score: -20, text: text };
      if (viewport.height > 0 && rect.y > viewport.height * 0.55) score += 15;
      if (editorRect && editorRect.width > 0) {
        if (Math.abs(rect.y - editorRect.y) < 120) score += 15;
      }
      var disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
      return { score: score, text: text, disabled: disabled };
    }

    function normalizeEditorButtonText(el) {
      return safeString(el.innerText || el.textContent || el.getAttribute('aria-label')).trim().split('\\n')[0];
    }

    function collectReplyEditorCandidates() {
      var viewport = { width: window.innerWidth || 0, height: window.innerHeight || 0 };
      var editorCandidates = [];
      var sendButtonCandidates = [];
      var seen = Object.create(null);

      try {
        var nodes = document.querySelectorAll(EDITOR_SELECTORS.join(','));
        for (var i = 0; i < nodes.length && i < 200; i++) {
          var el = nodes[i];
          if (!el || el.offsetParent === null) continue;
          var rect = getRect(el);
          if (rect.width < 80 || rect.height < 18) continue;
          var scored = scoreEditorEl(el, rect, viewport);
          if (scored.score <= 0) continue;
          var key = buildSelectorPath(el, 4) + ':' + rect.width + 'x' + rect.height;
          if (seen['e:' + key]) continue;
          seen['e:' + key] = 1;
          editorCandidates.push({
            selectorPath: buildSelectorPath(el, 5),
            editorType: detectEditorType(el),
            rect: rect,
            editorTextBefore: maskSensitiveText(getEditorText(el)).slice(0, 120),
            placeholder: safeString(el.getAttribute('placeholder')).slice(0, 80),
            ariaLabel: safeString(el.getAttribute('aria-label')).slice(0, 80),
            className: safeString(el.className).slice(0, 120),
            zone: scored.zone,
            score: scored.score
          });
        }
      } catch (e) {}

      editorCandidates.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
      var bestEditor = editorCandidates[0] || null;
      var editorRect = bestEditor ? bestEditor.rect : null;

      try {
        var btnNodes = [];
        var roots = [];
        try {
          var inputBox = document.querySelector('#im-input-box');
          if (inputBox) roots.push(inputBox);
          var workspaceChat = document.querySelector('#workspace-chat');
          if (workspaceChat) roots.push(workspaceChat);
        } catch (e) {}
        if (!roots.length) roots = [document];
        for (var ri = 0; ri < roots.length; ri++) {
          var scoped = roots[ri].querySelectorAll(SEND_BUTTON_SELECTORS.concat(['span', 'div']).join(','));
          for (var si = 0; si < scoped.length; si++) btnNodes.push(scoped[si]);
        }
        var globalBtns = document.querySelectorAll(SEND_BUTTON_SELECTORS.join(','));
        for (var gi = 0; gi < globalBtns.length; gi++) btnNodes.push(globalBtns[gi]);
        for (var j = 0; j < btnNodes.length && j < 300; j++) {
          var btn = btnNodes[j];
          if (!btn || btn.offsetParent === null) continue;
          var brect = getRect(btn);
          if (brect.width < 20 || brect.height < 16) continue;
          var bscore = scoreSendButtonEl(btn, brect, viewport, editorRect);
          if (bscore.score <= 0) continue;
          var bkey = buildSelectorPath(btn, 4) + ':' + bscore.text;
          if (seen['b:' + bkey]) continue;
          seen['b:' + bkey] = 1;
          sendButtonCandidates.push({
            selectorPath: buildSelectorPath(btn, 5),
            text: bscore.text,
            sendButtonText: bscore.text,
            rect: brect,
            disabled: bscore.disabled,
            sendButtonEnabled: !bscore.disabled,
            className: safeString(btn.className).slice(0, 120),
            score: bscore.score
          });
        }
      } catch (e) {}

      sendButtonCandidates.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
      return {
        viewport: viewport,
        editorCandidates: editorCandidates.slice(0, 20),
        sendButtonCandidates: sendButtonCandidates.slice(0, 20),
        hints: typeof readActiveConversationHints === 'function' ? readActiveConversationHints() : {}
      };
    }

    function findBestEditorElement() {
      var data = collectReplyEditorCandidates();
      if (!data.editorCandidates.length) return null;
      var bestPath = data.editorCandidates[0].selectorPath;
      try {
        var all = document.querySelectorAll(EDITOR_SELECTORS.join(','));
        for (var i = 0; i < all.length; i++) {
          if (buildSelectorPath(all[i], 5) === bestPath) return all[i];
        }
        return all[0] || null;
      } catch (e) { return null; }
    }

    function inspectReplyEditor() {
      var page = getPageInfo();
      if (!page.isImWorkspace) {
        send('bridge.log', { command: 'debug.inspect_reply_editor', success: false, reason: 'not_im_page' });
        return null;
      }
      var data = collectReplyEditorCandidates();
      var hints = data.hints || {};
      var payload = {
        shopInfo: {
          shopId: shopCache.shopId || '',
          shopName: shopCache.shopName || '',
          sessionPartitionKey: shopCache.sessionPartitionKey || '',
          accountId: maskValue(shopCache.accountId || ''),
        },
        bridgeId: bridgeId,
        href: page.href,
        viewport: data.viewport,
        editorCandidates: data.editorCandidates,
        sendButtonCandidates: data.sendButtonCandidates,
        selectedConversation: hints,
        conversationId: hints.conversationId || '',
        buyerId: hints.buyerId || '',
        buyerName: hints.buyerName || ''
      };
      send('doudian.reply.editor_inspection', payload);
      return payload;
    }

    function fillReplyDraft(payload) {
      var page = getPageInfo();
      if (!page.isImWorkspace) {
        send('bridge.log', { command: 'debug.fill_reply_draft', success: false, reason: 'not_im_page' });
        return null;
      }
      var draftText = safeString(payload && payload.draftText);
      if (!draftText) {
        send('doudian.reply.draft_filled', { success: false, reason: 'empty_draft_text', sent: false });
        return null;
      }

      var inspection = collectReplyEditorCandidates();
      var hints = inspection.hints || {};
      var editorEl = findBestEditorElement();
      if (!editorEl) {
        send('doudian.reply.draft_filled', {
          success: false,
          reason: 'reply_editor_not_found',
          sent: false,
          filled: false,
          fillVerified: false,
          sendNotCalled: true
        });
        return null;
      }

      var before = maskSensitiveText(getEditorText(editorEl)).slice(0, 120);
      var fillResult = fillEditorElement(editorEl, draftText);
      var bestBtn = inspection.sendButtonCandidates[0] || null;

      send('doudian.reply.draft_filled', {
        success: fillResult.ok,
        reason: fillResult.ok ? 'draft_filled' : 'fill_not_verified',
        sent: false,
        sendNotCalled: true,
        filled: Boolean(fillResult.ok),
        fillVerified: Boolean(fillResult.ok),
        draftText: maskSensitiveText(draftText).slice(0, 300),
        editorFound: true,
        editorSelectorPath: buildSelectorPath(editorEl, 5),
        editorType: detectEditorType(editorEl),
        editorTextBefore: before,
        editorTextAfter: fillResult.editorTextAfter || '',
        sendButtonFound: Boolean(bestBtn),
        sendButtonText: bestBtn ? bestBtn.text : '',
        sendButtonEnabled: bestBtn ? bestBtn.sendButtonEnabled : false,
        selectedConversation: hints,
        conversationId: hints.conversationId || '',
        buyerId: hints.buyerId || '',
        buyerName: hints.buyerName || '',
        bridgeId: bridgeId,
        href: page.href
      });
      return fillResult;
    }
`;
}

module.exports = {
  buildReplyEditorBrowserCode,
};
