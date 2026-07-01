/**
 * 千帆纯协议测试 — Node 直连 WS / HTTP 客户端（旁路，不依赖 CDP）
 */
const WebSocket = require('ws');
const { buildTextSendPayloadFromContext } = require('../qf-send-payload');
const { extractBuyerMessagesFromWsPayload, extractMessagesFromResponse } = require('../chat-parse');

const DEFAULT_ACK_TIMEOUT_MS = 8000;

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
    this.httpTemplates = shopConfig.httpTemplates || {};
    this.lastSeq = 0;
    this.ackWaiters = [];
    this.receivedFrames = [];
    this.buyerMessages = [];
    this.ws = null;
    this.actionStats = {};
  }

  buildHttpHeaders(extraHeaders = {}) {
    const base = {
      Cookie: this.cookie,
      'User-Agent': this.userAgent || 'qianfan-protocol-test/1.0',
      Origin: this.origin,
      Referer: this.referer,
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
    };
    return { ...base, ...extraHeaders };
  }

  buildWsHeaders() {
    const cfg = this.wsHeaders || {};
    return {
      Cookie: String(cfg.Cookie || cfg.cookie || this.cookie || '').trim(),
      'User-Agent': String(cfg['User-Agent'] || cfg.UserAgent || this.userAgent || '').trim(),
      Origin: String(cfg.Origin || cfg.origin || this.origin || '').trim(),
    };
  }

  _recordFrame(raw, parsed) {
    this.receivedFrames.push({ at: Date.now(), raw: String(raw).slice(0, 4000), parsed });
    if (!parsed || typeof parsed !== 'object') return;

    const action = String(parsed.header?.action || '(no-action)');
    this.actionStats[action] = (this.actionStats[action] || 0) + 1;

    if (action === '/sync/unreliable' || action.includes('/message/')) {
      const msgs = extractBuyerMessagesFromWsPayload(parsed, this.shopTitle);
      if (msgs.length) this.buyerMessages.push(...msgs);
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
  }

  async connectWs({ listenMs = 30000 } = {}) {
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
    this.ws = null;
    return report;
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

  async fetchMessageList(appCid) {
    const tpl = this.httpTemplates?.messageList;
    if (!tpl?.url) {
      return {
        ok: false,
        error: '缺少 httpTemplates.messageList.url',
        status: 0,
        rawBodyShape: 'missing-template',
        messageCount: 0,
        buyerMessageCount: 0,
        messagesPreview: [],
      };
    }

    const method = String(tpl.method || 'POST').toUpperCase();
    const body = replaceAppCidInBody(
      tpl.body && typeof tpl.body === 'object' ? JSON.parse(JSON.stringify(tpl.body)) : {},
      appCid
    );
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
        messagesPreview: [],
        bodyPreview: text.slice(0, 500),
      };
    }

    const messages = extractMessagesFromResponse(json, this.shopTitle, 'protocol_http');
    const buyerOnly = messages.filter((m) => !m.isSellerSide);
    const preview = buyerOnly.slice(0, 10).map((m) => ({
      buyerNick: m.buyerNick,
      text: String(m.text || '').slice(0, 120),
      appCid: m.appCid,
      msgId: m.msgId,
      createAt: m.createAt,
    }));

    return {
      ok: res.ok,
      status: res.status,
      rawBodyShape: describeBodyShape(json),
      messageCount: messages.length,
      buyerMessageCount: buyerOnly.length,
      messagesPreview: preview,
      error: res.ok ? '' : `HTTP ${res.status}`,
    };
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

  async sendText({ appCid, receiverAppUids, text, reallySend = false, verifyList = true }) {
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

  async openWsForSend() {
    if (!this.wsUrl) throw new Error('缺少 ws.url');
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    const headers = this.buildWsHeaders();
    this.receivedFrames = [];
    this.ackWaiters = [];

    await new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl, { headers });
      } catch (err) {
        reject(err);
        return;
      }
      const timer = setTimeout(() => reject(new Error('WS 连接超时')), 15000);
      this.ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.on('message', (data) => {
        const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        const parsed = safeJsonParse(raw);
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
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  closeWs() {
    try {
      if (this.ws) this.ws.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }
}

module.exports = {
  QianfanProtocolClient,
  matchesSendAck,
  parseSendAckFrame,
  summarizePayload,
  replaceAppCidInBody,
};
