/**
 * 千帆纯协议 IM 服务：仅 Node HTTP POST + WS（禁止 bridge / CDP / page_ws）
 */
const { QianfanProtocolClient } = require('./qianfan-protocol-client');
const { findProtocolShopConfig, probeShopConfig } = require('./qianfan-protocol-config');
const { readExistingLocalConfig } = require('./qianfan-live-context-extractor');
const { extractAuthFromSnapshot } = require('./qianfan-protocol-auth');
const { discoverSessionsFromSnapshot } = require('./qianfan-protocol-messages');
const { applyTapToShopConfig } = require('./qianfan-protocol-tap-config');
const { loadLiveSnapshot } = require('./qianfan-live-context-extractor');
const { isImpaasSendWsUrl } = require('./qianfan-protocol-ws-routing');
const {
  assertProtocolImSendAllowed,
  assertProtocolBridgeSendAllowed,
} = require('./qianfan-protocol-send-guard');
const { buildImagePayloadFromManualSample } = require('./qianfan-protocol-image');
const { uploadImageFromBase64, uploadImageFromPath } = require('./qianfan-protocol-eva-upload');
const {
  resolveSessionFromStore,
  persistSession,
  buildReceiverAppUid,
} = require('./qianfan-protocol-session-store');

const serviceCache = new Map();

function pickAuthHeaders(config, snapshot) {
  const fromConfig = config?.httpAuthHeaders || {};
  const auth = fromConfig.authorization || extractAuthFromSnapshot(snapshot);
  if (!auth) return fromConfig;
  return { authorization: auth };
}

function mergeShopConfig(builtConfig, snapshot, existing, tapApplied) {
  const out = JSON.parse(JSON.stringify(builtConfig || {}));
  if (snapshot?.lastSeq) out.lastSeq = snapshot.lastSeq;
  out.httpAuthHeaders = pickAuthHeaders(out, snapshot);

  const existTpl = existing?.httpTemplates?.messageList;
  if (existTpl?.url && !existTpl.url.includes('/batch') && !out.httpTemplates?.messageList?.url) {
    out.httpTemplates = out.httpTemplates || {};
    out.httpTemplates.messageList = existTpl;
  }

  const auth = out.httpAuthHeaders?.authorization;
  if (auth && out.httpTemplates?.messageList) {
    out.httpTemplates.messageList.headers = {
      ...(out.httpTemplates.messageList.headers || {}),
      authorization: auth,
    };
    delete out.httpTemplates.messageList.headers.Authorization;
  }
  if (out.httpAuthHeaders?.Authorization) {
    delete out.httpAuthHeaders.Authorization;
  }

  if (existing?.cookie && (!out.cookie || out.cookie.length < existing.cookie.length)) {
    out.cookie = existing.cookie;
  }
  if (existing?.ws?.sendUrl && !out.ws?.sendUrl) {
    out.ws = out.ws || {};
    out.ws.sendUrl = existing.ws.sendUrl;
  }
  if (existing?.ws?.apppushUrl && !out.ws?.apppushUrl) {
    out.ws = out.ws || {};
    out.ws.apppushUrl = existing.ws.apppushUrl;
  }
  if (existing?.wsUrlFromManualSend && !out.wsUrlFromManualSend) {
    out.wsUrlFromManualSend = existing.wsUrlFromManualSend;
  }
  if (existing?.ws?.authTemplate && !out.ws?.authTemplate) {
    out.ws = out.ws || {};
    out.ws.authTemplate = existing.ws.authTemplate;
  }
  if (existing?.ws?.handshakeHeaders && !out.ws?.handshakeHeaders) {
    out.ws = out.ws || {};
    out.ws.handshakeHeaders = existing.ws.handshakeHeaders;
  }
  if (existing?.manualSamples?.wsAuthPayload && !out.manualSamples?.wsAuthPayload) {
    out.manualSamples = out.manualSamples || {};
    out.manualSamples.wsAuthPayload = existing.manualSamples.wsAuthPayload;
  }
  if (existing?.manualSamples?.textSendPayload && !Object.keys(out.manualSamples?.textSendPayload || {}).length) {
    out.manualSamples = out.manualSamples || {};
    out.manualSamples.textSendPayload = existing.manualSamples.textSendPayload;
  }
  if (existing?.manualSamples?.imageSendPayload && !Object.keys(out.manualSamples?.imageSendPayload || {}).length) {
    out.manualSamples = out.manualSamples || {};
    out.manualSamples.imageSendPayload = existing.manualSamples.imageSendPayload;
  }
  if (existing?.httpTemplates?.imageUpload?.url && !out.httpTemplates?.imageUpload?.url) {
    out.httpTemplates = out.httpTemplates || {};
    out.httpTemplates.imageUpload = existing.httpTemplates.imageUpload;
  }
  if (existing?.httpTemplates?.imageUploadFlow?.length && !out.httpTemplates?.imageUploadFlow?.length) {
    out.httpTemplates = out.httpTemplates || {};
    out.httpTemplates.imageUploadFlow = existing.httpTemplates.imageUploadFlow;
  }
  if (existing?.testTarget?.appCid && !out.testTarget?.appCid) {
    out.testTarget = out.testTarget || {};
    out.testTarget.appCid = existing.testTarget.appCid;
    out.testTarget.receiverAppUids = existing.testTarget.receiverAppUids || [];
    out.testTarget.buyerNick = existing.testTarget.buyerNick || out.testTarget.buyerNick;
  }

  return { config: out, tapApplied };
}

function mergeLiveSnapshotHints(config, snapshot) {
  if (!snapshot?.ok) return config;
  const out = JSON.parse(JSON.stringify(config || {}));
  const cookie = String(snapshot.cookieSources?.mergedNetworkHeaderCookie || '').trim();
  if (cookie && (!out.cookie || cookie.length > out.cookie.length)) {
    out.cookie = cookie;
  }
  const auth = extractAuthFromSnapshot(snapshot);
  if (auth) out.httpAuthHeaders = { authorization: auth };

  const sendUrl = String(snapshot.wsUrlFromManualSend || '').trim();
  if (sendUrl && isImpaasSendWsUrl(sendUrl)) {
    out.ws = out.ws || {};
    out.ws.sendUrl = sendUrl;
    out.wsUrlFromManualSend = sendUrl;
  }
  for (const row of snapshot.allWsUrls || []) {
    const url = String(row?.url || '').trim();
    if (isImpaasSendWsUrl(url)) {
      out.ws = out.ws || {};
      out.ws.sendUrl = url;
      out.wsUrlFromManualSend = url;
      break;
    }
  }
  if (snapshot.lastSeq) out.lastSeq = Math.max(Number(out.lastSeq || 0), Number(snapshot.lastSeq));
  return out;
}

async function resolveProtocolShopConfig(shopTitle, options = {}) {
  const title = String(shopTitle || '').trim();
  const existing = readExistingLocalConfig().find((s) => s?.shopTitle === title) || null;
  let config = existing || findProtocolShopConfig(title, { allowIncomplete: true });

  if (options.useLiveSnapshot !== false) {
    try {
      const live = await loadLiveSnapshot(title, { refresh: Boolean(options.refreshLive) });
      if (live.ok && live.snapshot?.ok) {
        config = mergeLiveSnapshotHints(config, live.snapshot);
      }
    } catch {
      // live snapshot 可选
    }
  }

  const tapApplied = applyTapToShopConfig(config, { shopTitle: title });
  config = tapApplied.config;

  const merged = mergeShopConfig(config, null, existing, tapApplied);
  return {
    config: merged.config,
    snapshot: null,
    tapRows: tapApplied.tapRows || [],
    meta: {
      tapApplied: tapApplied.writtenFields,
      pureOnly: true,
      wsEndpoints: tapApplied.wsEndpoints || null,
      canWsSend: Boolean(tapApplied.wsEndpoints?.canSend),
    },
    source: tapApplied.listReq ? 'tap+local' : 'local',
  };
}

class QianfanProtocolService {
  constructor(shopTitle, options = {}) {
    this.shopTitle = String(shopTitle || '').trim();
    this.options = { pureOnly: true, ...options };
    this.config = null;
    this.meta = null;
    this.client = null;
    this.sessions = [];
    this.listenMode = 'none';
    this.stats = { frames: 0, buyerMessages: 0, httpLists: 0, sends: 0 };
  }

  async init() {
    const resolved = await resolveProtocolShopConfig(this.shopTitle, this.options);
    this.config = resolved.config;
    this.meta = resolved.meta;
    this.client = new QianfanProtocolClient(this.config);
    if (resolved.tapRows?.length) {
      this.client.refreshWsEndpoints(this.config, resolved.tapRows);
    }
    if (this.config.lastSeq) this.client.setLastSeq(this.config.lastSeq);
    if (this.config.httpAuthHeaders) this.client.setHttpAuthHeaders(this.config.httpAuthHeaders);
    this.sessions = this._sessionsFromConfig();
    return {
      ok: true,
      shopTitle: this.shopTitle,
      source: resolved.source,
      pureOnly: true,
      probe: probeShopConfig(this.config),
      sessionCount: this.sessions.length,
      tapApplied: this.meta?.tapApplied || [],
    };
  }

  _sessionsFromConfig() {
    const sessions = [];
    const target = this.config?.testTarget || {};
    if (target.appCid) {
      sessions.push({
        appCid: target.appCid,
        buyerNick: target.buyerNick || '',
        receiverAppUids: target.receiverAppUids || [],
        source: 'testTarget',
      });
    }
    const sample = this.config?.manualSamples?.textSendPayload?.body;
    if (sample?.appCid && !sessions.find((s) => s.appCid === sample.appCid)) {
      sessions.push({
        appCid: sample.appCid,
        buyerNick: target.buyerNick || '',
        receiverAppUids: sample.receiverAppUids || [],
        source: 'manualSamples',
      });
    }
    const imgSample = this.config?.manualSamples?.imageSendPayload?.body;
    if (imgSample?.appCid && !sessions.find((s) => s.appCid === imgSample.appCid)) {
      sessions.push({
        appCid: imgSample.appCid,
        buyerNick: target.buyerNick || '',
        receiverAppUids: imgSample.receiverAppUids || [],
        source: 'manualSamples.image',
      });
    }
    return sessions;
  }

  resolveBridgeSession(body = {}) {
    const fromStore = resolveSessionFromStore({
      shopTitle: body.shopTitle || this.shopTitle,
      buyerNick: body.buyerNick,
      buyerUserId: body.buyerUserId,
      appCid: body.appCid,
      receiverAppUids: body.receiverAppUids,
    });
    if (fromStore) return fromStore;

    const cid = String(body.appCid || '').trim();
    const uid = String(body.buyerUserId || '').trim();
    const recv =
      Array.isArray(body.receiverAppUids) && body.receiverAppUids.length
        ? body.receiverAppUids
        : uid
          ? [buildReceiverAppUid(uid)].filter(Boolean)
          : [];
    if (cid) {
      return {
        shopTitle: body.shopTitle || this.shopTitle,
        appCid: cid,
        buyerNick: body.buyerNick || '',
        buyerUserId: uid,
        receiverAppUids: recv,
        source: 'request',
      };
    }
    return null;
  }

  async openSession(body = {}) {
    const shopTitle = String(body.shopTitle || this.shopTitle || '').trim();
    const buyerNick = String(body.buyerNick || '').trim();
    const buyerUserId = String(body.buyerUserId || '').trim();
    if (!buyerUserId) {
      throw new Error('缺少买家信息，无法打开聊天');
    }

    const existing = this.resolveBridgeSession(body);
    if (existing?.appCid) {
      return { ok: true, created: false, session: existing };
    }

    const derivedReceiver = buildReceiverAppUid(buyerUserId);
    return {
      ok: true,
      created: true,
      pending: true,
      session: {
        appCid: '',
        receiverAppUids: derivedReceiver ? [derivedReceiver] : [],
        buyerNick,
        shopTitle,
        buyerUserId,
        source: 'protocol_derived',
      },
      message: '买家 receiver 已推导，请携带订单 appCid 发送或等待会话缓存更新',
    };
  }

  async sendTextForBridge({
    appCid,
    receiverAppUids,
    text,
    buyerNick,
    buyerUserId,
    shopTitle,
    reallySend = true,
  }) {
    const session = this.resolveBridgeSession({
      shopTitle: shopTitle || this.shopTitle,
      appCid,
      receiverAppUids,
      buyerNick,
      buyerUserId,
    });
    const nick = buyerNick || session?.buyerNick || '';
    assertProtocolBridgeSendAllowed(nick, 'protocol_bridge_text');

    const sendAppCid = String(appCid || session?.appCid || '').trim();
    const sendUids =
      (Array.isArray(receiverAppUids) && receiverAppUids.length
        ? receiverAppUids
        : session?.receiverAppUids) || [];
    if (!sendAppCid) {
      throw new Error('缺少 appCid，请先 open-session 或在订单中带 appCid');
    }
    if (!sendUids.length) {
      throw new Error('缺少 receiverAppUids');
    }

    if (reallySend) {
      await this.client.openWsForSend();
    }
    const result = await this.client.sendText({
      appCid: sendAppCid,
      receiverAppUids: sendUids,
      text,
      reallySend,
      verifyList: false,
      buyerNick: nick,
    });
    this.stats.sends += 1;
    if (reallySend && result.ok) {
      persistSession({
        shopTitle: shopTitle || this.shopTitle,
        appCid: sendAppCid,
        buyerUserId: buyerUserId || session?.buyerUserId,
        buyerNick: nick,
        receiverAppUids: sendUids,
      });
    }
    return {
      ...result,
      buyerNick: nick,
      appCid: sendAppCid,
      pureOnly: true,
      method: 'node_ws',
      session: { ...session, appCid: sendAppCid, receiverAppUids: sendUids },
    };
  }

  async sendImageForBridge({
    appCid,
    receiverAppUids,
    buyerNick,
    buyerUserId,
    shopTitle,
    imageBase64,
    imagePath,
    width = 0,
    height = 0,
    reallySend = true,
  }) {
    const session = this.resolveBridgeSession({
      shopTitle: shopTitle || this.shopTitle,
      appCid,
      receiverAppUids,
      buyerNick,
      buyerUserId,
    });
    const nick = buyerNick || session?.buyerNick || '';
    assertProtocolBridgeSendAllowed(nick, 'protocol_bridge_image');

    const sendAppCid = String(appCid || session?.appCid || '').trim();
    const sendUids =
      (Array.isArray(receiverAppUids) && receiverAppUids.length
        ? receiverAppUids
        : session?.receiverAppUids) || [];
    if (!sendAppCid) throw new Error('缺少 appCid');
    if (!sendUids.length) throw new Error('缺少 receiverAppUids');

    let uploadResult = null;
    if (imageBase64) {
      uploadResult = await uploadImageFromBase64(this.config, imageBase64, { width, height });
    } else if (imagePath) {
      uploadResult = await uploadImageFromPath(this.config, imagePath, { width, height });
    } else {
      throw new Error('请先拍照或选图');
    }
    if (!uploadResult.ok) {
      throw new Error(uploadResult.error || '图片上传失败');
    }

    if (reallySend) {
      await this.client.openWsForSend();
    }

    const seq = (this.client?.lastSeq || this.config?.lastSeq || 0) + 1;
    const built = buildImagePayloadFromManualSample({
      shopConfig: this.config,
      appCid: sendAppCid,
      receiverAppUids: sendUids,
      uploadResult: { resource: uploadResult.resource },
      seq,
    });
    if (!built.ok || !built.payload) {
      throw new Error(built.error || '图片 payload 构建失败');
    }

    const content = built.payload?.body?.contentInfo?.content;
    if (content && typeof content === 'object' && uploadResult.resource) {
      content.width = uploadResult.width || width || content.width || 1080;
      content.height = uploadResult.height || height || content.height || 1920;
      content.extension = content.extension || {};
      content.extension.resource = JSON.stringify(uploadResult.resource);
      if (built.payload.body.extension?.additionInfo) {
        built.payload.body.extension.additionInfo = JSON.stringify({ extType: '' });
      }
    }

    let sendResult = { ok: false, skipped: true };
    if (reallySend) {
      sendResult = await this.client.sendRawWsPayload(built.payload, { reallySend: true });
      this.client.closeWs();
      if (sendResult.ok) {
        persistSession({
          shopTitle: shopTitle || this.shopTitle,
          appCid: sendAppCid,
          buyerUserId: buyerUserId || session?.buyerUserId,
          buyerNick: nick,
          receiverAppUids: sendUids,
        });
      }
    }

    this.stats.sends += 1;
    return {
      ok: sendResult.ok,
      uploadResult,
      built,
      sendResult,
      buyerNick: nick,
      appCid: sendAppCid,
      pureOnly: true,
      method: 'node_ws',
      traceId: built.traceId,
      msgId: sendResult.ack?.msgId || '',
    };
  }

  listSessions() {
    return [...this.sessions];
  }

  resolveSendTarget(appCid, buyerNick) {
    const resolved = this.resolveSession(appCid, buyerNick);
    if (resolved?.appCid) return resolved;

    const target = this.config?.testTarget || {};
    if (target.appCid) {
      return {
        appCid: target.appCid,
        buyerNick: target.buyerNick || '',
        receiverAppUids: target.receiverAppUids || [],
        source: 'testTarget',
      };
    }
    return null;
  }

  resolveSession(appCid, buyerNick) {
    const cid = String(appCid || '').trim();
    if (cid) {
      const hit = this.sessions.find((s) => s.appCid === cid);
      if (hit) return hit;
    }
    const nick = String(buyerNick || '').trim();
    if (nick) {
      const hit = this.sessions.find((s) => s.buyerNick && s.buyerNick.includes(nick));
      if (hit) return hit;
    }
    return this.sessions[0] || null;
  }

  async startListen(handlers = {}) {
    this.stopListen();
    const started = await this.client.startListening({
      onFrame: (parsed) => {
        this.stats.frames += 1;
        if (typeof handlers.onFrame === 'function') handlers.onFrame(parsed);
      },
      onBuyerMessage: (msg, parsed) => {
        this.stats.buyerMessages += 1;
        if (typeof handlers.onBuyerMessage === 'function') handlers.onBuyerMessage(msg, parsed);
      },
    });
    this.listenMode = started.ok ? 'node_ws' : 'none';
    return { ok: started.ok, mode: this.listenMode, wsUrl: started.wsUrl, pureOnly: true };
  }

  stopListen() {
    if (this.client) this.client.stopListening();
    this.listenMode = 'none';
  }

  async pullSessionHistory(appCid, options = {}) {
    const session = this.resolveSession(appCid, options.buyerNick);
    const cid = String(appCid || session?.appCid || '').trim();
    if (!cid) return { ok: false, error: 'missing_app_cid' };

    const listenMs = Number(options.listenMs || 4000);
    try {
      await this.client.ensureWsListenReady();
    } catch (err) {
      return {
        ok: false,
        error: err.message || String(err),
        source: 'protocol_ws',
        session: session || { appCid: cid },
        messages: [],
        messageCount: 0,
      };
    }
    const result = await this.client.collectWsSessionMessages(cid, { listenMs });
    return {
      ...result,
      session: session || { appCid: cid },
      buyerMessageCount: (result.messages || []).filter((m) => !m.isSellerSide).length,
      messagesPreview: (result.messages || []).slice(-10),
    };
  }

  async pullAllSessionsMessages(options = {}) {
    const sessions = options.sessions || this.sessions;
    const results = [];
    for (const session of sessions) {
      if (!session?.appCid) continue;
      const row = await this.pullSessionHistory(session.appCid, {
        ...options,
        maxPages: options.maxPagesPerSession || options.maxPages || 10,
      });
      results.push({
        appCid: session.appCid,
        buyerNick: session.buyerNick || '',
        ok: row.ok,
        messageCount: row.messages?.length || row.messageCount || 0,
        pages: row.pages || 1,
        error: row.error || '',
        messages: options.includeMessages ? row.messages || [] : undefined,
      });
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    }
    const totalMessages = results.reduce((n, r) => n + (r.messageCount || 0), 0);
    return {
      ok: results.some((r) => r.ok),
      sessionCount: results.length,
      totalMessages,
      sessions: results,
      pureOnly: true,
    };
  }

  async sendText({
    appCid,
    receiverAppUids,
    text,
    buyerNick,
    reallySend = false,
    verifyList = true,
  }) {
    const session = reallySend
      ? this.resolveSendTarget(appCid, buyerNick)
      : this.resolveSession(appCid, buyerNick);
    const nick = buyerNick || session?.buyerNick || this.config?.testTarget?.buyerNick || '';

    if (reallySend) {
      if (!session?.appCid) {
        throw new Error(`[千帆协议IM] 未找到目标买家「${nick || '(未知)'}」的会话 appCid`);
      }
      assertProtocolImSendAllowed(nick, 'protocol_im_send');
    }

    const sendAppCid = reallySend ? String(session.appCid) : String(appCid || session?.appCid || '');
    const sendUids =
      receiverAppUids || session?.receiverAppUids || this.config?.testTarget?.receiverAppUids || [];

    if (reallySend) {
      await this.client.openWsForSend();
    }

    const result = await this.client.sendText({
      appCid: sendAppCid,
      receiverAppUids: sendUids,
      text,
      reallySend,
      verifyList: reallySend ? false : verifyList,
      buyerNick: nick,
    });
    this.stats.sends += 1;
    return { ...result, buyerNick: nick, appCid: sendAppCid, pureOnly: true, method: 'node_ws' };
  }

  getStatus() {
    return {
      shopTitle: this.shopTitle,
      listenMode: this.listenMode,
      pureOnly: true,
      stats: { ...this.stats },
      probe: this.config ? probeShopConfig(this.config) : null,
      sessionCount: this.sessions.length,
      client: {
        wsOpen: Boolean(this.client?.ws && this.client.ws.readyState === 1),
        wsListenOpen: Boolean(this.client?.wsListen && this.client.wsListen.readyState === 1),
        wsAuthed: Boolean(this.client?.wsAuthed),
        wsChannelId: this.client?.wsChannelId || '',
        wsSendUrl: this.client?.wsSendUrl || '',
        wsListenUrl: this.client?.wsListenUrl || '',
        canWsSend: Boolean(this.client?.wsEndpoints?.canSend),
        wsUrl: this.client?.wsUrl || '',
        lastSeq: this.client?.lastSeq || 0,
        buyerMessages: this.client?.buyerMessages?.length || 0,
      },
    };
  }
}

async function getProtocolImService(shopTitle, options = {}) {
  const key = `${shopTitle}::pure`;
  if (!options.noCache && serviceCache.has(key)) {
    return serviceCache.get(key);
  }
  const svc = new QianfanProtocolService(shopTitle, { pureOnly: true, ...options });
  await svc.init();
  if (!options.noCache) serviceCache.set(key, svc);
  return svc;
}

function clearProtocolImServiceCache() {
  for (const svc of serviceCache.values()) {
    try {
      svc.stopListen();
    } catch {
      // ignore
    }
  }
  serviceCache.clear();
}

module.exports = {
  QianfanProtocolService,
  getProtocolImService,
  clearProtocolImServiceCache,
  resolveProtocolShopConfig,
  mergeShopConfig,
};
