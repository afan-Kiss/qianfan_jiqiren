const fs = require('fs');
const path = require('path');
const { ensureDir, resolveLogsDir } = require('../../shared/app-root');
const { getHistorySyncConfig } = require('../../shared/config');
const { historyLog } = require('../../shared/history-log');
const { redactPayload } = require('../../shared/sensitive-redact');

const URL_HINTS = ['history', 'conversation', 'message', 'chat', 'session', 'pigeon', 'msg_list', 'msglist'];
const JSON_HINTS = ['conversationId', 'conversation_id', 'msgId', 'msg_id', 'messageId', 'content', 'buyer', 'customer'];

function scoreCandidate(url, jsonText) {
  const u = String(url || '').toLowerCase();
  let score = 0;
  for (const h of URL_HINTS) {
    if (u.includes(h)) score += 2;
  }
  const j = String(jsonText || '').slice(0, 5000).toLowerCase();
  for (const h of JSON_HINTS) {
    if (j.includes(String(h).toLowerCase())) score += 1;
  }
  if (j.includes('"messages"') || j.includes('"msg_list"')) score += 3;
  if (j.includes('"conversation_list"') || j.includes('"conversations"')) score += 3;
  return score;
}

function classifyCandidate(url, bodyText) {
  const u = String(url || '').toLowerCase();
  let kind = 'unknown';
  if (/conversation.*list|get_current_conversation|session_list/.test(u)) kind = 'conversation_list';
  else if (/message|msg_list|msglist|chat_history|history/.test(u)) kind = 'message_list';
  else if (/conversation|session|chat/.test(u)) kind = 'conversation_detail';
  else if (/get_link_info|link_info/.test(u)) kind = 'link_info';

  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = null;
  }
  return { kind, parsed };
}

class HistoryNetworkSniffer {
  constructor(client, options = {}) {
    this.client = client;
    this.options = options;
    this.requests = new Map();
    this.responses = new Map();
    this.candidates = [];
    this.enabled = false;
    this.off = null;
  }

  async enable() {
    if (this.enabled) return;
    await this.client.send('Network.enable');
    this.enabled = true;
    this.off = this.client.on((event) => this.handleEvent(event));
    historyLog('[HISTORY_SNIFFER]', 'Network.enable ok');
  }

  handleEvent(event) {
    if (event.type !== 'event') return;
    const method = event.method;
    const p = event.params || {};

    if (method === 'Network.requestWillBeSent') {
      this.requests.set(p.requestId, {
        url: p.request?.url || '',
        method: p.request?.method || 'GET',
        headers: p.request?.headers || {},
        postData: p.request?.postData || '',
        timestamp: Date.now(),
      });
      return;
    }

    if (method === 'Network.responseReceived') {
      const req = this.requests.get(p.requestId) || {};
      this.responses.set(p.requestId, {
        url: p.response?.url || req.url || '',
        status: p.response?.status,
        mimeType: p.response?.mimeType || '',
        headers: p.response?.headers || {},
      });
      return;
    }

    if (method === 'Network.loadingFinished') {
      this.captureResponse(p.requestId).catch(() => {});
    }
  }

  async captureResponse(requestId) {
    const req = this.requests.get(requestId) || {};
    const resp = this.responses.get(requestId) || {};
    const url = resp.url || req.url || '';
    if (!url || !/json|text|javascript/i.test(resp.mimeType || 'json')) {
      if (!/history|conversation|message|chat|session|pigeon|im\./i.test(url)) return;
    }

    let bodyText = '';
    try {
      const body = await this.client.send('Network.getResponseBody', { requestId });
      bodyText = body.base64Encoded
        ? Buffer.from(body.body || '', 'base64').toString('utf8')
        : String(body.body || '');
    } catch {
      return;
    }

    const score = scoreCandidate(url, bodyText);
    if (score < 3) return;

    const { kind, parsed } = classifyCandidate(url, bodyText);
    const candidate = {
      requestId,
      url,
      method: req.method,
      kind,
      score,
      status: resp.status,
      bodyPreview: bodyText.slice(0, 500),
      bodyLength: bodyText.length,
      hasJson: Boolean(parsed),
      paginationHints: detectPagination(parsed, req.postData),
      timeHints: detectTimeParams(req.url, req.postData),
      timestamp: Date.now(),
    };

    this.candidates.push(candidate);
    historyLog('[HISTORY_SNIFFER]', `candidate kind=${kind} score=${score} url=${url.slice(0, 80)}`);
  }

  async listen(listenMs = 12000) {
    await this.enable();
    historyLog('[HISTORY_SNIFFER]', `listening ${Math.round(listenMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, listenMs));
    this.candidates.sort((a, b) => b.score - a.score);
    return this.getCandidates();
  }

  getCandidates() {
    return this.candidates.slice();
  }

  getBestByKind(kind) {
    return this.candidates.filter((c) => c.kind === kind).sort((a, b) => b.score - a.score)[0] || null;
  }

  dispose() {
    if (this.off) this.off();
    this.off = null;
  }

  saveReports(options = {}) {
    const cfg = getHistorySyncConfig();
    if (!cfg.saveApiCandidates && !options.force) return null;

    const dir = ensureDir(resolveLogsDir());
    const jsonPath = path.join(dir, 'history-api-candidates-latest.json');
    const txtPath = path.join(dir, 'history-api-candidates-latest.txt');

    const safe = this.candidates.map((c) => ({
      ...c,
      headers: undefined,
      bodyPreview: c.bodyPreview,
    }));

    fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), candidates: safe }, null, 2), 'utf8');

    const lines = [
      'History API Candidates',
      `generatedAt: ${new Date().toISOString()}`,
      `count: ${safe.length}`,
      '',
      ...safe.map(
        (c, i) =>
          `${i + 1}. [${c.kind}] score=${c.score} ${c.method} ${c.status} ${c.url}\n   pagination=${JSON.stringify(c.paginationHints)} time=${JSON.stringify(c.timeHints)}\n   preview=${redactPayload(c.bodyPreview).slice(0, 200)}`
      ),
    ];
    fs.writeFileSync(txtPath, lines.join('\n'), 'utf8');
    return { jsonPath, txtPath };
  }
}

function detectPagination(parsed, postData) {
  const hints = [];
  const text = JSON.stringify(parsed || {}) + String(postData || '');
  for (const key of ['page', 'pageNo', 'page_num', 'cursor', 'offset', 'limit', 'size', 'pageSize']) {
    if (new RegExp(`"${key}"`, 'i').test(text) || new RegExp(`${key}=`, 'i').test(text)) hints.push(key);
  }
  return hints;
}

function detectTimeParams(url, postData) {
  const hints = [];
  const text = String(url || '') + String(postData || '');
  for (const key of ['startTime', 'endTime', 'begin_time', 'end_time', 'from_time', 'to_time', 'timestamp']) {
    if (new RegExp(key, 'i').test(text)) hints.push(key);
  }
  return hints;
}

module.exports = {
  HistoryNetworkSniffer,
  scoreCandidate,
  classifyCandidate,
};
