const { historyLog } = require('../../shared/history-log');
const { getHistorySyncConfig } = require('../../shared/config');
const { parseChatHistoryPayload } = require('../../platforms/doudian/doudian-pigeon-parser');
const { normalizeConversationList, normalizeBatch } = require('./history-message-normalizer');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildHeaders(pageMeta, cookies = []) {
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    cookie: cookieHeader,
    referer: pageMeta.pageUrl || 'https://im.jinritemai.com/',
    origin: 'https://im.jinritemai.com',
    'user-agent':
      pageMeta.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
}

class HistoryApiClient {
  constructor(client, options = {}) {
    this.client = client;
    this.pageMeta = options.pageMeta || {};
    this.cfg = { ...getHistorySyncConfig(), ...(options.historySync || {}) };
    this.cookies = [];
  }

  async loadCookies() {
    const urls = [this.pageMeta.pageUrl, 'https://im.jinritemai.com', 'https://fxg.jinritemai.com'].filter(Boolean);
    try {
      const res = await this.client.send('Network.getCookies', { urls });
      this.cookies = res.cookies || [];
      historyLog('[HISTORY_API]', `loaded cookies count=${this.cookies.length}`);
      return this.cookies.length > 0;
    } catch (err) {
      historyLog('[HISTORY_ERROR]', '[HISTORY_API] getCookies failed', String(err.message || err));
      return false;
    }
  }

  async fetchUrl(url, options = {}) {
    if (!this.cookies.length) await this.loadCookies();
    const headers = buildHeaders(this.pageMeta, this.cookies);
    const method = options.method || 'GET';
    const body = options.body || null;

    historyLog('[HISTORY_API]', `${method} ${url.slice(0, 100)}`);

    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers: { ...headers, ...(options.headers || {}) },
          body,
          signal: AbortSignal.timeout(15000),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        await sleep(this.cfg.requestIntervalMs || 800);
        return { ok: true, status: res.status, text, json };
      } catch (err) {
        lastErr = err;
        await sleep(500 * (attempt + 1));
      }
    }
    return { ok: false, error: String(lastErr?.message || lastErr) };
  }

  async pullFromCandidate(candidate, meta = {}) {
    if (!candidate?.url) return { conversations: [], messages: [] };
    const res = await this.fetchUrl(candidate.url, { method: candidate.method || 'GET' });
    if (!res.ok || !res.json) {
      historyLog('[HISTORY_ERROR]', '[HISTORY_API] fetch candidate failed', res.error || 'no json');
      return { conversations: [], messages: [], error: res.error };
    }

    const normalized = normalizeConversationList(res.json, {
      ...meta,
      url: candidate.url,
      source: 'history-api',
    });

    const messages = normalizeBatch(normalized.messages, {
      ...meta,
      source: 'history-api',
      confidence: 0.7,
    });

    if (!messages.length) {
      const parsed = parseChatHistoryPayload(res.json, meta, { url: candidate.url });
      const batch = normalizeBatch(parsed.messages, { ...meta, source: 'history-api', confidence: 0.65 });
      messages.push(...batch);
    }

    historyLog('[HISTORY_API]', `parsed conv=${normalized.conversations.length} msg=${messages.length}`);
    return {
      conversations: normalized.conversations,
      messages,
      apiName: normalized.apiName,
    };
  }

  async pullFromCandidates(candidates, meta = {}) {
    const allConversations = [];
    const allMessages = [];
    const seenUrls = new Set();

    for (const c of candidates.slice(0, 10)) {
      if (seenUrls.has(c.url)) continue;
      seenUrls.add(c.url);
      const result = await this.pullFromCandidate(c, meta);
      allConversations.push(...(result.conversations || []));
      allMessages.push(...(result.messages || []));
    }

    return { conversations: allConversations, messages: allMessages };
  }
}

module.exports = {
  HistoryApiClient,
  buildHeaders,
};
