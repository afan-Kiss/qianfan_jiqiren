/**
 * 浏览器端：UI 填入 + 点击发送 + 聊天区校验（仅 debug.send_message_to_buyer）
 */
function buildMessageSendBrowserCode() {
  return `
    function findSendButtonByPath(selectorPath) {
      if (!selectorPath) return null;
      try {
        var btns = document.querySelectorAll(SEND_BUTTON_SELECTORS.join(','));
        for (var i = 0; i < btns.length; i++) {
          if (buildSelectorPath(btns[i], 5) === selectorPath) return btns[i];
        }
        return btns[0] || null;
      } catch (e) { return null; }
    }

    function textsSimilar(a, b) {
      var left = safeString(a).trim();
      var right = safeString(b).trim();
      if (!left || !right) return false;
      if (left === right) return true;
      if (left.indexOf(right) >= 0 || right.indexOf(left) >= 0) return true;
      return false;
    }

    function sendViaEnterKey(editorEl) {
      if (!editorEl) return false;
      try {
        editorEl.focus();
        var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        editorEl.dispatchEvent(new KeyboardEvent('keydown', opts));
        editorEl.dispatchEvent(new KeyboardEvent('keypress', opts));
        editorEl.dispatchEvent(new KeyboardEvent('keyup', opts));
        return true;
      } catch (e) { return false; }
    }

    function finishSendResult(base, fillResult, hints, page, text, sendMeta) {
      setTimeout(function () {
        var verify = verifySellerMessageInChat(text);
        send('doudian.message.send_result', Object.assign({
          success: !!verify.verified,
          reason: verify.verified ? 'message_sent_and_verified' : 'sent_but_not_verified',
          confirmSend: true,
          editorFound: true,
          filled: !!fillResult.ok,
          fillVerified: !!fillResult.ok,
          sendClicked: true,
          sent: true,
          verifiedInChat: !!verify.verified,
          text: maskSensitiveText(text).slice(0, 300),
          buyerId: hints.buyerId || '',
          buyerName: hints.buyerName || '',
          conversationId: hints.conversationId || '',
          selectedConversation: hints,
          bridgeId: bridgeId,
          href: page.href,
          verifyReason: verify.reason || '',
          verifiedBubbleText: verify.bubbleText || ''
        }, sendMeta || {}));
      }, 1500);
    }

    function verifySellerMessageInChat(expectedText) {
      var inspection = typeof inspectChatDom === 'function' ? inspectChatDom() : null;
      if (!inspection) return { verified: false, reason: 'no_chat_inspection' };
      var bubbles = inspection.candidateBubbles || [];
      for (var i = 0; i < bubbles.length; i++) {
        var b = bubbles[i];
        var dir = safeString(b.directionGuess);
        var isSeller = dir === 'seller' || b.isRightBubble === true;
        if (!isSeller) continue;
        if (!textsSimilar(b.text, expectedText)) continue;
        return {
          verified: true,
          reason: 'seller_message_found',
          bubbleText: maskSensitiveText(safeString(b.text)).slice(0, 200),
          direction: dir || 'seller'
        };
      }
      return { verified: false, reason: 'seller_message_not_found' };
    }

    function sendMessageToBuyer(payload) {
      var confirmSend = !!(payload && payload.confirmSend);
      var text = safeString(payload && payload.text);
      var base = {
        confirmSend: confirmSend,
        sent: false,
        sendClicked: false,
        verifiedInChat: false,
        editorFound: false,
        sendButtonFound: false,
        sendButtonEnabled: false,
        filled: false,
        fillVerified: false
      };

      if (!confirmSend) {
        send('doudian.message.send_result', Object.assign({}, base, {
          success: false,
          reason: 'missing_confirm_send'
        }));
        return null;
      }
      if (!text) {
        send('doudian.message.send_result', Object.assign({}, base, {
          success: false,
          reason: 'empty_text'
        }));
        return null;
      }

      var page = getPageInfo();
      if (!page.isImWorkspace) {
        send('doudian.message.send_result', Object.assign({}, base, {
          success: false,
          reason: 'not_im_page'
        }));
        return null;
      }

      var hints = typeof readActiveConversationHints === 'function' ? readActiveConversationHints() : {};
      var inspection = collectReplyEditorCandidates();
      var editorEl = findBestEditorElement();
      if (!editorEl) {
        send('doudian.message.send_result', Object.assign({}, base, {
          success: false,
          reason: 'reply_editor_not_found'
        }));
        return null;
      }

      var fillResult = fillEditorElement(editorEl, text);
      if (!fillResult.ok) {
        send('doudian.message.send_result', Object.assign({}, base, {
          success: false,
          reason: 'fill_failed',
          editorFound: true,
          filled: false,
          fillVerified: false
        }));
        return null;
      }

      var bestBtn = inspection.sendButtonCandidates[0] || null;
      if (!bestBtn) {
        if (sendViaEnterKey(editorEl)) {
          finishSendResult(base, fillResult, hints, page, text, {
            sendButtonFound: false,
            sendButtonEnabled: false,
            sendMethod: 'enter_key'
          });
          return { queued: true };
        }
        send('doudian.message.send_result', Object.assign({}, base, {
          success: false,
          reason: 'send_button_not_found',
          editorFound: true,
          filled: true,
          fillVerified: true
        }));
        return null;
      }
      if (bestBtn.disabled || bestBtn.sendButtonEnabled === false) {
        send('doudian.message.send_result', Object.assign({}, base, {
          success: false,
          reason: 'send_button_disabled',
          editorFound: true,
          filled: !!fillResult.ok,
          fillVerified: !!fillResult.ok,
          sendButtonFound: true,
          sendButtonEnabled: false
        }));
        return null;
      }

      var btnEl = findSendButtonByPath(bestBtn.selectorPath);
      if (!btnEl) {
        send('doudian.message.send_result', Object.assign({}, base, {
          success: false,
          reason: 'send_button_element_not_found',
          editorFound: true,
          filled: !!fillResult.ok,
          fillVerified: !!fillResult.ok,
          sendButtonFound: true,
          sendButtonEnabled: true
        }));
        return null;
      }

      try {
        btnEl.focus();
        btnEl.click();
      } catch (e) {
        send('doudian.message.send_result', Object.assign({}, base, {
          success: false,
          reason: 'send_click_failed',
          editorFound: true,
          filled: !!fillResult.ok,
          fillVerified: !!fillResult.ok,
          sendButtonFound: true,
          sendButtonEnabled: true
        }));
        return null;
      }

      finishSendResult(base, fillResult, hints, page, text, {
        sendButtonFound: true,
        sendButtonEnabled: true,
        sendMethod: 'button_click'
      });
      return { queued: true };
    }
`;
}

module.exports = {
  buildMessageSendBrowserCode,
};
