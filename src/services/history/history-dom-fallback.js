const fs = require('fs');
const path = require('path');
const { ensureDir, resolveLogsDir } = require('../../shared/app-root');
const { getHistorySyncConfig } = require('../../shared/config');
const { historyLog } = require('../../shared/history-log');
const { normalizeBatch } = require('./history-message-normalizer');

const DEFAULT_SELECTORS = {
  conversationList: "[class*='conversation'], [class*='session-list'], [data-testid*='conversation']",
  conversationItem: "[class*='conversation-item'], [class*='session-item'], li[class*='item']",
  messageList: "[class*='message-list'], [class*='chat-content'], [class*='im-message']",
  messageBubble: "[class*='message-item'], [class*='bubble'], [class*='chat-item']",
  buyerBubble: "[class*='buyer'], [class*='customer'], [class*='left']",
  sellerBubble: "[class*='seller'], [class*='service'], [class*='right']",
  messageText: "[class*='text'], [class*='content']",
  messageTime: "time, [class*='time'], [class*='timestamp']",
};

function buildDomScript(selectors) {
  return `(function(){
    var sel = ${JSON.stringify(selectors)};
    function qsa(s, root){ try { return Array.from((root||document).querySelectorAll(s)); } catch(e){ return []; } }
    var convItems = qsa(sel.conversationItem).slice(0, 20);
    var bubbles = qsa(sel.messageBubble).slice(0, 50);
    var conversations = convItems.map(function(el, i){
      return { index: i, name: (el.innerText||'').trim().slice(0, 80), html: el.outerHTML.slice(0, 300) };
    });
    var messages = bubbles.map(function(el, i){
      var cls = el.className || '';
      var textEl = el.querySelector(sel.messageText) || el;
      var timeEl = el.querySelector(sel.messageTime);
      var direction = 'unknown';
      if (/buyer|customer|left/i.test(cls)) direction = 'buyer';
      else if (/seller|service|right|shop/i.test(cls)) direction = 'seller';
      return {
        index: i,
        direction: direction,
        text: (textEl.innerText||'').trim().slice(0, 500),
        time: timeEl ? (timeEl.innerText||timeEl.getAttribute('datetime')||'').trim() : '',
        html: el.outerHTML.slice(0, 300)
      };
    }).filter(function(m){ return m.text; });
    return {
      url: location.href,
      title: document.title,
      conversationCount: conversations.length,
      messageCount: messages.length,
      conversations: conversations,
      messages: messages,
      bodyPreview: document.body ? document.body.innerText.slice(0, 800) : ''
    };
  })()`;
}

class HistoryDomFallback {
  constructor(client, pageMeta, options = {}) {
    this.client = client;
    this.pageMeta = pageMeta;
    this.cfg = { ...getHistorySyncConfig(), ...(options.historySync || {}) };
    this.selectors = { ...DEFAULT_SELECTORS, ...(this.cfg.domSelectors || {}) };
  }

  async extract() {
    historyLog('[HISTORY_DOM]', 'starting DOM fallback extract');
    try {
      const res = await this.client.send('Runtime.evaluate', {
        expression: buildDomScript(this.selectors),
        returnByValue: true,
      });
      const data = res?.result?.value || {};
      this.saveDomSnapshot(data);

      const items = (data.messages || []).map((m, idx) => ({
        text: m.text,
        content: m.text,
        direction: m.direction,
        timestamp: m.time || Date.now(),
        messageId: '',
        conversationId: this.pageMeta.conversationId || '',
        buyerName: '',
      }));

      const normalized = normalizeBatch(items, {
        shopId: this.pageMeta.shopId,
        shopName: this.pageMeta.shopName,
        platform: this.pageMeta.platform,
        source: 'history-dom',
        confidence: 0.35,
      });

      historyLog('[HISTORY_DOM]', `extracted messages=${normalized.length} conversations=${data.conversationCount || 0}`);
      return {
        ok: normalized.length > 0,
        conversations: (data.conversations || []).map((c) => ({
          conversationId: `dom:${c.index}`,
          buyerName: c.name,
          source: 'history-dom',
        })),
        messages: normalized,
        domSummary: {
          conversationCount: data.conversationCount,
          messageCount: data.messageCount,
          url: data.url,
          title: data.title,
        },
      };
    } catch (err) {
      historyLog('[HISTORY_ERROR]', '[HISTORY_DOM] extract failed', String(err.message || err));
      return { ok: false, messages: [], conversations: [], error: String(err.message || err) };
    }
  }

  saveDomSnapshot(data) {
    try {
      const dir = ensureDir(resolveLogsDir());
      const htmlPath = path.join(dir, 'history-dom-snapshot-latest.txt');
      const lines = [
        `url: ${data.url || ''}`,
        `title: ${data.title || ''}`,
        `conversations: ${data.conversationCount || 0}`,
        `messages: ${data.messageCount || 0}`,
        '',
        'bodyPreview:',
        data.bodyPreview || '',
        '',
        'sample messages:',
        ...(data.messages || []).slice(0, 10).map((m) => `[${m.direction}] ${m.time} ${m.text}`),
      ];
      fs.writeFileSync(htmlPath, lines.join('\n'), 'utf8');
    } catch {
      // ignore
    }
  }
}

module.exports = {
  HistoryDomFallback,
  DEFAULT_SELECTORS,
};
