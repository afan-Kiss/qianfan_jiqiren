/**
 * 千帆纯协议测试 — Node 直连 WS / HTTP 客户端（旁路，不依赖 CDP）
 */
const WebSocket = require('ws');
const { buildTextSendPayloadFromContext } = require('../qf-send-payload');
const {
  extractBuyerMessagesFromWsPayload,
  extractMessagesFromResponse,
  parseMaybeJson,
} = require('../chat-parse');
const { mergeHttpAuthHeaders, pickHeader } = require('./qianfan-protocol-auth');
const {
  buildWsAuthFrame,
  parseAuthAckFrame,
  cleanWsHandshakeHeaders,
  makeTraceId,
} = require('./qianfan-protocol-ws-auth');
const {
  needsWsAuthHandshake,
  supportsMessageSend,
  resolveProtocolWsEndpoints,
  formatMissingSendUrlError,
} = require('./qianfan-protocol-ws-routing');
const {
  extractAllChatMessages,
  parseMessageListMeta,
} = require('./qianfan-protocol-messages');

const DEFAULT_ACK_TIMEOUT_MS = 8000;
const DEFAULT_AUTH_TIMEOUT_MS = 10000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function summarizePayload(payload) {
  const hdr = payload?.header || {};
  const body = payload?.body || {};
  return {
    action: hdr.action || '',
    type: hdr.type,
    seq: hdr.seq,
    traceId: hdr.traceId || '',
    sMid: hdr.sMid || '',
    appCid: body.appCid || '',
    receiverCount: Array.isArray(body.receiverAppUids) ? body.receiverAppUids.length : 0,
    contentType: body.contentInfo?.contentType,
    contentPreview: String(body.contentInfo?.content || '').slice(0, 80),
    uuid: body.uuid || '',
  };
}

function matchesSendAck(parsed, ctx) {
  const hdr = parsed?.header || {};
  const body = parsed?.body || {};
  if (hdr.action !== '/message/send') return false;
  const ackType = Number(hdr.type);
  if (ackType === 3) return false;
  if (ackType !== 131 && ackType !== 130 && ackType !== 132) {
    if (body.code == null || !body.data?.msgId) return false;
  }
  if (body.code == null && body.msg == null && !body.data?.msgId) return false;
  if (ctx.traceId && hdr.traceId && hdr.traceId === ctx.traceId) return true;
  if (ctx.sMid && hdr.sMid && hdr.sMid === ctx.sMid) return true;
  const dataUuid = body.data?.uuid || body.uuid;
  if (ctx.uuid && dataUuid && dataUuid === ctx.uuid) return true;
  return false;
}

function parseSendAckFrame(parsed, ctx) {
  if (!matchesSendAck(parsed, ctx)) return null;
  const body = parsed?.body || {};
  if (body.code === 0 && body.data?.msgId) {
    return {
      msgId: String(body.data.msgId),
      createAt: body.data.createAt,
      ackParsed: parsed,
      ackData: body.data || {},
      traceId: ctx.traceId,
      sMid: ctx.sMid,
      uuid: ctx.uuid,
    };
  }
  if (body.code != null && body.code !== 0) {
    return { error: new Error(body.msg || `ACK code ${body.code}`) };
  }
  return null;
}

function replaceAppCidInBody(body, appCid) {
  if (!body || typeof body !== 'object') return body;
  const out = Array.isArray(body) ? [...body] : { ...body };
  if (Array.isArray(out)) return out;

  if ('appCid' in out) out.appCid = appCid;
  if ('cid' in out) out.cid = appCid;
  if (out.data && typeof out.data === 'object') {
    out.data = { ...out.data };
    if ('appCid' in out.data) out.data.appCid = appCid;
  }
  if (Array.isArray(out.appCidList)) out.appCidList = [appCid];
  if (Array.isArray(out.cids)) out.cids = [appCid];
  return out;
}

function describeBodyShape(body) {
  if (body == null) return 'null';
  if (Array.isArray(body)) return `array[len=${body.length}]`;
  if (typeof body === 'object') return `object[keys=${Object.keys(body).slice(0, 12).join(',')}]`;
  return typeof body;
}

class QianfanProtocolClient {
  constructor(shopConfig) {
    this.shopConfig = shopConfig;
    this.shopTitle = shopConfig.shopTitle;
    this.cookie = shopConfig.cookie;
    this.userAgent = shopConfig.userAgent;
    this.origin = shopConfig.origin;
    this.referer = shopConfig.referer;
    this.wsUrl = String(shopConfig?.ws?.url || '').trim();
    this.wsHeaders = shopConfig?.ws?.headers || {};
    this.wsEndpoints = resolveProtocolWsEndpoints(shopConfig);
    this.wsSendUrl = this.wsEndpoints.sendUrl || '';
    this.wsListenUrl = this.wsEndpoints.listenUrl || this.wsUrl || '';
    this.httpTemplates = shopConfig.httpTemplates || {};
    this.httpAuthHeaders = shopConfig.httpAuthHeaders || {};
    this.lastSeq = Number(shopConfig.lastSeq || 0);
    this.ackWaiters = [];
    this.authWaiters = [];
    this.receivedFrames = [];
    this.buyerMessages = [];
    this.allMessages = [];
    this.ws = null;
    this.wsListen = null;
    this.wsAuthed = false;
    this.wsChannelId = '';
    this._authPromise = null;
    this.actionStats = {};
    this._listenActive = false;
    this._onFrame = null;
  }

  setHttpAuthHeaders(headers) {
    this.httpAuthHeaders = { ...(headers || {}) };
  }

  setLastSeq(seq) {
    const n = Number(seq || 0);
    if (n > this.lastSeq) this.lastSeq = n;
  }

  buildHttpHeaders(extraHeaders = {}) {
    const tpl = this.httpTemplates?.messageList || {};
    const isImpaas = String(tpl.url || '').includes('/api/impaas/');
    const base = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent || 'qianfan-protocol-test/1.0',
    };
    if (!isImpaas) {
      base.Origin = this.origin;
      base.Referer = this.referer;
      if (this.cookie) base.Cookie = this.cookie;
    }
    return mergeHttpAuthHeaders(base, { ...this.httpAuthHeaders, ...(extraHeaders || {}) }, this.cookie, {
      sendCookie: !isImpaas,
    });
  }

  refreshWsEndpoints(shopConfig, tapRows = []) {
    this.shopConfig = shopConfig || this.shopConfig;
    this.wsEndpoints = resolveProtocolWsEndpoints(this.shopConfig, tapRows);
    this.wsSendUrl = this.wsEndpoints.sendUrl || '';
    this.wsListenUrl = this.wsEndpoints.listenUrl || this.wsUrl || '';
    if (this.wsSendUrl) this.wsUrl = this.wsSendUrl;
    else if (this.wsListenUrl) this.wsUrl = this.wsListenUrl;
  }

  buildWsHeaders(url = '') {
    const targetUrl = String(url || this.wsListenUrl || this.wsSendUrl || this.wsUrl || '');
    const useApppushHandshake = needsWsAuthHandshake(targetUrl);
    const hs = this.shopConfig?.ws?.handshakeHeaders || {};
    const cfg = this.wsHeaders || {};
    const auth = pickHeader(this.httpAuthHeaders, 'authorization') || pickHeader(cfg, 'authorization');
    const headers = cleanWsHandshakeHeaders(
      { ...hs, ...cfg },
      useApppushHandshake
        ? ''
        : String(cfg.Cookie || cfg.cookie || this.cookie || '').trim(),
      String(hs['User-Agent'] || cfg['User-Agent'] || cfg.UserAgent || this.userAgent || '').trim(),
      String(hs.Origin || cfg.Origin || cfg.origin || this.origin || '').trim()
    );
    if (!useApppushHandshake && auth) headers.authorization = auth;
    return headers;
  }

  _recordFrame(raw, parsed) {
    this.receivedFrames.push({ at: Date.now(), raw: String(raw).slice(0, 4000), parsed });
    if (!parsed || typeof parsed !== 'object') return;

    const action = String(parsed.header?.action || '(no-action)');
    this.actionStats[action] = (this.actionStats[action] || 0) + 1;

    if (action === '/sync/unreliable' || action.includes('/message/')) {
      const msgs = extractBuyerMessagesFromWsPayload(parsed, this.shopTitle);
      if (msgs.length) {
        this.buyerMessages.push(...msgs);
        this.allMessages.push(...msgs);
      }
    }

    if (typeof this._onFrame === 'function') {
      try {
        this._onFrame(parsed, raw);
      } catch {
        // ignore
      }
    }

    if (action === '/message/send') {
      for (let i = this.ackWaiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.ackWaiters[i];
        const ack = parseSendAckFrame(parsed, waiter.ctx);
        if (!ack) continue;
        clearTimeout(waiter.timer);
        this.ackWaiters.splice(i, 1);
        if (ack.error) waiter.reject(ack.error);
        else waiter.resolve(ack);
      }
    }

    if (action === 'auth') {
      for (let i = this.authWaiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.authWaiters[i];
        const ack = parseAuthAckFrame(parsed);
        if (!ack) continue;
        clearTimeout(waiter.timer);
        this.authWaiters.splice(i, 1);
        if (ack.ok) {
          this.wsAuthed = true;
          this.wsChannelId = ack.channelId || '';
          waiter.resolve(ack);
        } else {
          waiter.reject(ack.error || new Error('WS auth 失败'));
        }
      }
    }
  }

  _attachWsHandlers(socket) {
    if (!socket) return;
    socket.on('message', (data) => {
      const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      const parsed = safeJsonParse(raw);
      this._recordFrame(raw, parsed);
    });
    socket.on('ping', () => {
      try {
        if (socket.readyState === WebSocket.OPEN) socket.pong();
      } catch {
        // ignore
      }
    });
  }

  async _connectWs(url, { role = 'listen' } = {}) {
    const targetUrl = String(url || '').trim();
    if (!targetUrl) throw new Error('缺少 ws url');

    const existing =
      role === 'send'
        ? (this.ws?.readyState === WebSocket.OPEN ? this.ws : null) ||
          (targetUrl === this.wsListenUrl && this.wsListen?.readyState === WebSocket.OPEN
            ? this.wsListen
            : null)
        : this.wsListen || (targetUrl === this.wsSendUrl ? this.ws : null);
    if (existing && existing.readyState === WebSocket.OPEN) {
      if (role === 'listen') this.wsListen = existing;
      if (role === 'send') this.ws = existing;
      if (needsWsAuthHandshake(targetUrl) && !this.wsAuthed) {
        await this.authenticateWs({ target: role === 'send' ? 'send' : 'listen' });
      }
      return;
    }

    const headers = this.buildWsHeaders(targetUrl);
    if (role === 'send') {
      this.receivedFrames = [];
      this.ackWaiters = [];
      this.authWaiters = [];
      this.wsAuthed = false;
      this.wsChannelId = '';
    }

    const socket = await new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(targetUrl, { headers });
      } catch (err) {
        reject(err);
        return;
      }
      const timer = setTimeout(() => reject(new Error(`WS 连接超时 (${role})`)), 15000);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve(ws);
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    this._attachWsHandlers(socket);
    if (role === 'send') {
      this.ws = socket;
      if (targetUrl === this.wsListenUrl) this.wsListen = socket;
    } else {
      this.wsListen = socket;
      if (!this.ws || targetUrl === this.wsSendUrl) this.ws = socket;
    }

    if (needsWsAuthHandshake(targetUrl)) {
      await this.authenticateWs({ target: role === 'send' ? 'send' : 'listen' });
    }
  }

  async connectWs({ listenMs = 30000, keepOpen = false } = {}) {
    const report = {
      ok: false,
      connected: false,
      frameCount: 0,
      jsonFrameCount: 0,
      actions: {},
      buyerMessageCount: 0,
      ackCount: 0,
      closeCode: null,
      closeReason: '',
      errors: [],
    };

    if (!this.wsUrl) {
      report.errors.push('缺少 ws.url，无法建立纯协议 WS 连接');
      return report;
    }

    const headers = this.buildWsHeaders();
    if (!headers.Cookie) report.errors.push('WS headers 缺少 Cookie');

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      try {
        this.ws = new WebSocket(this.wsUrl, { headers });
      } catch (err) {
        report.errors.push(`WS 构造失败: ${err.message || err}`);
        finish();
        return;
      }

      this.ws.on('open', () => {
        report.connected = true;
        console.log(`[protocol] WS 已连接 shop=${this.shopTitle}`);
      });

      this.ws.on('message', (data) => {
        const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        report.frameCount += 1;
        const parsed = safeJsonParse(raw);
        if (parsed) report.jsonFrameCount += 1;
        this._recordFrame(raw, parsed);
      });

      this.ws.on('ping', () => {
        try {
          if (this.ws?.readyState === WebSocket.OPEN) this.ws.pong();
        } catch {
          // ignore
        }
      });

      this.ws.on('error', (err) => {
        report.errors.push(`WS error: ${err.message || err}`);
      });

      this.ws.on('close', (code, reasonBuf) => {
        report.closeCode = code;
        report.closeReason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString() : String(reasonBuf || '');
      });

      if (keepOpen) {
        this._listenActive = true;
        finish();
        return;
      }

      setTimeout(() => {
        try {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
        } catch {
          // ignore
        }
        finish();
      }, Math.max(1000, Number(listenMs) || 30000));
    });

    report.actions = { ...this.actionStats };
    report.buyerMessageCount = this.buyerMessages.length;
    report.ackCount = this.receivedFrames.filter((f) => f.parsed?.header?.action === '/message/send').length;
    report.ok = report.connected && report.errors.length === 0;
    if (!keepOpen) this.ws = null;
    return report;
  }

  async startListening({ onFrame, onBuyerMessage } = {}) {
    this._onFrame = (parsed) => {
      if (typeof onFrame === 'function') onFrame(parsed);
      if (typeof onBuyerMessage === 'function') {
        const msgs = extractBuyerMessagesFromWsPayload(parsed, this.shopTitle);
        for (const m of msgs) onBuyerMessage(m, parsed);
      }
    };
    try {
      await this.ensureWsListenReady();
    } catch {
      // node WS 连接失败时保持 listenMode=none
    }
    this._listenActive = true;
    const listenSock = this.wsListen || this.ws;
    return {
      ok: Boolean(listenSock && listenSock.readyState === WebSocket.OPEN),
      wsUrl: this.wsListenUrl || this.wsUrl,
    };
  }

  stopListening() {
    this._listenActive = false;
    this._onFrame = null;
    this.closeWs();
  }

  buildMessageListBody(appCid, options = {}) {
    const tpl = this.httpTemplates?.messageList || {};
    const body = tpl.body && typeof tpl.body === 'object' ? JSON.parse(JSON.stringify(tpl.body)) : {};
    if (Array.isArray(body.appCids)) {
      body.appCids = [appCid];
    } else {
      body.appCid = appCid;
    }
    if (options.cursor != null) body.cursor = options.cursor;
    if (options.count != null) body.count = options.count;
    if (options.limit != null) body.limit = options.limit;
    if (options.direction != null) body.direction = options.direction;
    if (!body.count && !body.limit) {
      body.count = 20;
      body.limit = 20;
    }
    return body;
  }

  async waitForAuthAck(traceId, timeoutMs = DEFAULT_AUTH_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.authWaiters.findIndex((w) => w.traceId === traceId);
        if (idx >= 0) this.authWaiters.splice(idx, 1);
        reject(new Error('WS auth ACK 超时'));
      }, timeoutMs);

      this.authWaiters.push({ traceId, resolve, reject, timer });

      for (const frame of this.receivedFrames) {
        const ack = parseAuthAckFrame(frame.parsed);
        if (!ack) continue;
        if (traceId && ack.traceId && ack.traceId !== traceId) continue;
        clearTimeout(timer);
        const idx = this.authWaiters.findIndex((w) => w.traceId === traceId);
        if (idx >= 0) this.authWaiters.splice(idx, 1);
        if (ack.ok) {
          this.wsAuthed = true;
          this.wsChannelId = ack.channelId || '';
          resolve(ack);
        } else {
          reject(ack.error || new Error('WS auth 失败'));
        }
        return;
      }
    });
  }

  async authenticateWs({ force = false, target = 'listen' } = {}) {
    const sock = target === 'send' ? this.ws : this.wsListen || this.ws;
    const url = target === 'send' ? this.wsSendUrl : this.wsListenUrl;
    if (!needsWsAuthHandshake(url)) {
      return { ok: true, skipped: true, reason: 'impaas_send_no_auth' };
    }
    if (this.wsAuthed && !force) {
      return { ok: true, channelId: this.wsChannelId, cached: true };
    }
    if (!sock || sock.readyState !== WebSocket.OPEN) {
      throw new Error('WS 未连接，无法 auth');
    }
    if (this._authPromise && !force) return this._authPromise;

    this._authPromise = (async () => {
      const seq = this.lastSeq + 1;
      const traceId = makeTraceId();
      const frame = buildWsAuthFrame(this.shopConfig, seq, { traceId });
      if (!frame.body?.sid) {
        throw new Error('WS auth 缺少 sid（需 tap 刷新 authorization 或 ws.authTemplate）');
      }
      if (!frame.body?.uid) {
        throw new Error('WS auth 缺少 uid（需 tap 捕获 auth 帧刷新 ws.authTemplate）');
      }

      const authWait = this.waitForAuthAck(traceId);
      sock.send(JSON.stringify(frame));
      const ack = await authWait;
      if (Number(frame.header.seq) > this.lastSeq) {
        this.lastSeq = Number(frame.header.seq);
      }
      return ack;
    })();

    try {
      return await this._authPromise;
    } finally {
      this._authPromise = null;
    }
  }

  async ensureWsListenReady() {
    const url = String(this.wsListenUrl || '').trim();
    if (!url) throw new Error('缺少 ws listen url');
    if (!this.wsListen || this.wsListen.readyState !== WebSocket.OPEN) {
      await this._connectWs(url, { role: 'listen' });
    }
    if (needsWsAuthHandshake(url) && !this.wsAuthed) {
      await this.authenticateWs({ target: 'listen' });
    }
  }

  async ensureWsSendReady() {
    const url = String(this.wsSendUrl || '').trim();
    if (!url || !supportsMessageSend(url)) {
      throw new Error(formatMissingSendUrlError());
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this._connectWs(url, { role: 'send' });
    }
    if (needsWsAuthHandshake(url) && !this.wsAuthed) {
      await this.authenticateWs({ target: 'send' });
    }
  }

  async ensureWsAuthenticated() {
    if (this.wsSendUrl && supportsMessageSend(this.wsSendUrl)) {
      await this.ensureWsSendReady();
      return;
    }
    await this.ensureWsListenReady();
  }

  async waitForAck(ctx, timeoutMs = DEFAULT_ACK_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.ackWaiters.findIndex((w) => w.ctx === ctx);
        if (idx >= 0) this.ackWaiters.splice(idx, 1);
        reject(new Error('ACK 超时'));
      }, timeoutMs);

      this.ackWaiters.push({ ctx, resolve, reject, timer });

      for (const frame of this.receivedFrames) {
        const ack = parseSendAckFrame(frame.parsed, ctx);
        if (!ack) continue;
        clearTimeout(timer);
        const idx = this.ackWaiters.findIndex((w) => w.ctx === ctx);
        if (idx >= 0) this.ackWaiters.splice(idx, 1);
        if (ack.error) reject(ack.error);
        else resolve(ack);
        return;
      }
    });
  }

  async sendRawWsPayload(payload, { reallySend = false, waitAck = true, ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS } = {}) {
    const summary = summarizePayload(payload);
    const ctx = {
      traceId: payload?.header?.traceId || summary.traceId,
      sMid: payload?.header?.sMid || summary.sMid,
      uuid: payload?.body?.uuid || summary.uuid,
      seq: payload?.header?.seq,
      appCid: payload?.body?.appCid,
      text: payload?.body?.contentInfo?.content,
    };

    if (!reallySend) {
      return {
        ok: true,
        dryRun: true,
        traceId: ctx.traceId,
        sMid: ctx.sMid,
        uuid: ctx.uuid,
        payloadSummary: summary,
      };
    }

    if (!this.wsUrl) {
      return { ok: false, dryRun: false, error: '缺少 ws.url', ...ctx };
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { ok: false, dryRun: false, error: 'WS 未连接', ...ctx };
    }

    if (reallySend) {
      try {
        await this.ensureWsSendReady();
      } catch (err) {
        return { ok: false, dryRun: false, error: err.message || String(err), ...ctx };
      }
    }

    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    try {
      this.ws.send(payloadStr);
      if (Number(payload?.header?.seq) > this.lastSeq) {
        this.lastSeq = Number(payload.header.seq);
      }
    } catch (err) {
      return { ok: false, dryRun: false, error: err.message || String(err), ...ctx };
    }

    if (!waitAck) {
      return { ok: true, dryRun: false, sent: true, ...ctx };
    }

    try {
      const ack = await this.waitForAck(ctx, ackTimeoutMs);
      return { ok: true, dryRun: false, sent: true, ack, ...ctx };
    } catch (err) {
      return { ok: false, dryRun: false, error: err.message || String(err), ...ctx };
    }
  }

  async fetchMessageList(appCid, options = {}) {
    const tpl = this.httpTemplates?.messageList;
    if (!tpl?.url) {
      return {
        ok: false,
        error: '缺少 httpTemplates.messageList.url',
        status: 0,
        rawBodyShape: 'missing-template',
        messageCount: 0,
        buyerMessageCount: 0,
        messages: [],
        messagesPreview: [],
      };
    }

    const method = String(tpl.method || 'POST').toUpperCase();
    const body = this.buildMessageListBody(appCid, options);
    const headers = this.buildHttpHeaders(tpl.headers || {});

    let res;
    let text = '';
    try {
      res = await fetch(tpl.url, {
        method,
        headers,
        body: method === 'GET' ? undefined : JSON.stringify(body),
      });
      text = await res.text();
    } catch (err) {
      return {
        ok: false,
        error: err.message || String(err),
        status: 0,
        rawBodyShape: 'fetch-error',
        messageCount: 0,
        buyerMessageCount: 0,
        messages: [],
        messagesPreview: [],
      };
    }

    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: '响应不是 JSON',
        status: res.status,
        rawBodyShape: `text[len=${text.length}]`,
        messageCount: 0,
        buyerMessageCount: 0,
        messages: [],
        messagesPreview: [],
        bodyPreview: text.slice(0, 500),
      };
    }

    const meta = parseMessageListMeta(json);
    const messages = extractAllChatMessages(json, this.shopTitle, 'protocol_http');
    const buyerOnly = messages.filter((m) => !m.isSellerSide);
    const preview = messages.slice(-10).map((m) => ({
      buyerNick: m.buyerNick,
      text: String(m.text || '').slice(0, 120),
      appCid: m.appCid,
      msgId: m.msgId,
      createAt: m.createAt,
      isSellerSide: m.isSellerSide,
      contentType: m.contentType,
    }));

    const apiOk = res.ok && meta.success && meta.msg !== '商家信息有误';

    return {
      ok: apiOk,
      status: res.status,
      rawBodyShape: describeBodyShape(json),
      messageCount: messages.length,
      buyerMessageCount: buyerOnly.length,
      messages,
      messagesPreview: preview,
      hasMore: meta.hasMore,
      nextCursor: meta.nextCursor,
      apiMsg: meta.msg,
      error: apiOk ? '' : meta.msg || `HTTP ${res.status}`,
      requestBody: body,
    };
  }

  async fetchAllSessionMessages(appCid, options = {}) {
    const maxPages = Number(options.maxPages || 30);
    const all = [];
    const seen = new Set();
    let cursor = options.cursor != null ? options.cursor : -1;
    let hasMore = true;
    let pages = 0;
    let lastError = '';

    while (hasMore && pages < maxPages) {
      const page = await this.fetchMessageList(appCid, {
        cursor,
        count: options.count || 20,
        limit: options.limit || 20,
        direction: options.direction != null ? options.direction : false,
      });
      pages += 1;
      if (!page.ok) {
        lastError = page.error || page.apiMsg || 'list_failed';
        if (pages === 1) return { ok: false, error: lastError, messages: [], pages, appCid };
        break;
      }
      for (const msg of page.messages || []) {
        const key = `${msg.appCid}::${msg.msgId}`;
        if (!msg.msgId || seen.has(key)) continue;
        seen.add(key);
        all.push(msg);
      }
      hasMore = Boolean(page.hasMore);
      if (page.nextCursor != null && page.nextCursor >= 0) {
        cursor = page.nextCursor;
      } else {
        hasMore = false;
      }
      if (!page.messageCount) hasMore = false;
    }

    all.sort((a, b) => Number(a.createAt || 0) - Number(b.createAt || 0));
    return { ok: true, messages: all, pages, appCid, lastError };
  }

  buildTextPayload({ appCid, receiverAppUids, text }) {
    const seq = this.lastSeq + 1;
    const manualTemplate =
      this.shopConfig?.manualSamples?.textSendPayload &&
      Object.keys(this.shopConfig.manualSamples.textSendPayload).length
        ? { payload: this.shopConfig.manualSamples.textSendPayload }
        : null;

    return buildTextSendPayloadFromContext({
      shopTitle: this.shopTitle,
      appCid,
      receiverAppUids,
      text,
      seq,
      sessionContext: null,
      manualTemplate,
    });
  }

  async sendText({
    appCid,
    receiverAppUids,
    text,
    reallySend = false,
    verifyList = true,
    buyerNick = '',
  }) {
    if (!appCid) return { ok: false, error: '缺少 appCid' };
    if (!Array.isArray(receiverAppUids) || !receiverAppUids.length) {
      return { ok: false, error: '缺少 receiverAppUids' };
    }
    if (!String(text || '').trim()) return { ok: false, error: '缺少 text' };

    const built = this.buildTextPayload({ appCid, receiverAppUids, text });
    const sendResult = await this.sendRawWsPayload(built.payload, { reallySend });

    let listVerify = { skipped: true };
    if (reallySend && verifyList && sendResult.ok) {
      listVerify = await this.verifySendViaMessageList({
        appCid,
        text,
        traceId: sendResult.traceId,
        msgId: sendResult.ack?.msgId,
      });
    }
    return {
      ...sendResult,
      payloadValid: Boolean(built.payload?.header?.action === '/message/send'),
      payloadSummary: summarizePayload(built.payload),
      built,
      listVerify,
    };
  }

  async verifySendViaMessageList({ appCid, text, traceId = '', msgId = '' }) {
    const list = await this.fetchMessageList(appCid);
    if (!list.ok) {
      return { ok: false, skipped: false, reason: list.error || 'message_list_failed', list };
    }
    const needle = String(text || '').trim();
    const hit = (list.messagesPreview || []).find((m) => {
      const body = String(m.text || '');
      if (msgId && String(m.msgId || '') === String(msgId)) return true;
      if (needle && body.includes(needle)) return true;
      return false;
    });
    return {
      ok: Boolean(hit),
      skipped: false,
      found: Boolean(hit),
      traceId,
      msgId,
      messageCount: list.messageCount,
      previewCount: list.messagesPreview?.length || 0,
    };
  }

  async collectWsSessionMessages(appCid, { listenMs = 5000 } = {}) {
    await this.ensureWsListenReady();
    const before = this.allMessages.length;
    await sleep(Math.max(500, Number(listenMs) || 5000));
    const cid = String(appCid || '').trim();
    const messages = (this.allMessages || []).filter((m) => !cid || m.appCid === cid);
    return {
      ok: true,
      source: 'protocol_ws',
      messageCount: messages.length,
      messages,
      newFrames: this.allMessages.length - before,
      wsAuthed: this.wsAuthed,
      channelId: this.wsChannelId,
    };
  }

  async openWsForSend() {
    await this.ensureWsSendReady();
  }

  closeWs() {
    for (const sock of [this.ws, this.wsListen]) {
      try {
        if (sock) sock.close();
      } catch {
        // ignore
      }
    }
    this.ws = null;
    this.wsListen = null;
    this.wsAuthed = false;
    this.wsChannelId = '';
    this._authPromise = null;
    this.authWaiters = [];
  }
}

module.exports = {
  QianfanProtocolClient,
  matchesSendAck,
  parseSendAckFrame,
  summarizePayload,
  replaceAppCidInBody,
};
