/**
 * 千帆纯协议守护进程核心（每店铺 WS + HTTP 兜底轮询）
 */
const fs = require('fs');
const crypto = require('crypto');
const { QianfanProtocolClient } = require('./qianfan-protocol-client');
const { applyTapToShopConfig } = require('./qianfan-protocol-tap-config');
const { localConfigPath, readJsonFile } = require('./qianfan-protocol-config');
const { resolveProtocolWsEndpoints } = require('./qianfan-protocol-ws-routing');
const { MessageDedupStore } = require('./qianfan-protocol-daemon-dedup');
const {
  formatBuyerNotice,
  formatCredentialExpiredNotice,
  sendDaemonWxNotify,
} = require('./qianfan-protocol-daemon-notify');
const {
  extractBuyerMessagesFromWsPayload,
  isIgnoredMessage,
  isWsBuyerCandidate,
} = require('../chat-parse');
const { println } = require('../utils');

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 120000;
const CREDENTIAL_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_HTTP_POLL_MS = 45000;
const DEFAULT_ACTIVITY_TIMEOUT_MS = 120000;
const MAX_EVENT_LOG = 20;

function shopIdFromTitle(shopTitle) {
  return String(shopTitle || '').trim() || 'unknown';
}

function isCredentialError(errOrMsg) {
  const text = String(errOrMsg?.message || errOrMsg || '').toLowerCase();
  return (
    text.includes('unauthorized') ||
    text.includes('user unauthorized') ||
    text.includes('凭证') ||
    text.includes('auth 失败') ||
    text.includes('sid')
  );
}

function collectWatchAppCids(shopConfig = {}) {
  const set = new Set();
  const target = shopConfig.testTarget || {};
  if (target.appCid) set.add(String(target.appCid).trim());
  const sample = shopConfig.manualSamples?.textSendPayload?.body?.appCid;
  if (sample) set.add(String(sample).trim());
  return [...set].filter(Boolean);
}

function loadShopsFromConfigFile(configPath = localConfigPath()) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`配置文件不存在: ${configPath}`);
  }
  const all = readJsonFile(configPath);
  return all.filter(
    (row) => row && row.enabled !== false && String(row.shopTitle || '').trim()
  );
}

function enrichShopConfig(shopConfig, tapRows = []) {
  const applied = applyTapToShopConfig(shopConfig, { shopTitle: shopConfig.shopTitle });
  const config = applied.config;
  const endpoints = resolveProtocolWsEndpoints(config, tapRows);
  if (endpoints.sendUrl) {
    config.ws = config.ws || {};
    config.ws.sendUrl = endpoints.sendUrl;
  }
  if (endpoints.apppushUrl) config.ws.apppushUrl = endpoints.apppushUrl;
  if (endpoints.listenUrl) config.ws.listenUrl = endpoints.listenUrl;
  return { config, endpoints, tapRows: applied.tapRows || tapRows };
}

class ShopWorker {
  constructor(shopConfig, daemon, options = {}) {
    this.daemon = daemon;
    this.shopTitle = shopConfig.shopTitle;
    this.shopId = shopIdFromTitle(this.shopTitle);
    this.shopConfig = shopConfig;
    this.endpoints = options.endpoints || resolveProtocolWsEndpoints(shopConfig);
    this.client = null;
    this._socket = null;
    this._stopped = false;
    this._reconnectTimer = null;
    this._httpPollTimer = null;
    this._activityTimer = null;
    this._reconnectCount = 0;
    this._backoffMs = RECONNECT_MIN_MS;
    this._credentialRetryAt = 0;
    this._credentialNotifiedAt = 0;
    this.state = {
      shopId: this.shopId,
      shopName: this.shopTitle,
      connected: false,
      authed: false,
      credentialExpired: false,
      lastAuthAt: 0,
      lastMessageAt: 0,
      lastHttpPollAt: 0,
      lastActivityAt: 0,
      reconnectCount: 0,
      lastError: '',
      wsUrl: this.endpoints.listenUrl || this.endpoints.apppushUrl || '',
      canWsSend: Boolean(this.endpoints.canSend),
    };
  }

  logEvent(kind, detail = {}) {
    this.daemon.pushEvent({
      at: Date.now(),
      kind,
      shopTitle: this.shopTitle,
      ...detail,
    });
  }

  async markCredentialExpired(reason, channel = 'WS') {
    this.state.credentialExpired = true;
    this.state.connected = false;
    this.state.authed = false;
    this.state.lastError = String(reason || 'credential_expired');
    this._credentialRetryAt = Date.now() + CREDENTIAL_COOLDOWN_MS;
    this.logEvent('credential_expired', { reason, channel });
    this.teardownSocket();

    const now = Date.now();
    if (now - this._credentialNotifiedAt > CREDENTIAL_COOLDOWN_MS) {
      this._credentialNotifiedAt = now;
      await sendDaemonWxNotify(
        formatCredentialExpiredNotice({
          shopTitle: this.shopTitle,
          reason: this.state.lastError,
          channel,
        })
      );
    }
  }

  teardownSocket() {
    if (this._socket) {
      try {
        this._socket.removeAllListeners('close');
        this._socket.removeAllListeners('error');
      } catch {
        // ignore
      }
    }
    this._socket = null;
    if (this.client) {
      try {
        this.client.stopListening();
      } catch {
        // ignore
      }
    }
    this.client = null;
    this.state.connected = false;
    this.state.authed = false;
  }

  touchActivity() {
    const now = Date.now();
    this.state.lastActivityAt = now;
    this._resetActivityWatch();
  }

  _resetActivityWatch() {
    if (this._activityTimer) clearTimeout(this._activityTimer);
    const timeoutMs = Number(this.daemon.options.activityTimeoutMs || DEFAULT_ACTIVITY_TIMEOUT_MS);
    this._activityTimer = setTimeout(() => {
      if (this._stopped || this.state.credentialExpired) return;
      this.logEvent('activity_timeout', { timeoutMs });
      this.scheduleReconnect('activity_timeout');
    }, timeoutMs);
  }

  scheduleReconnect(reason = '') {
    if (this._stopped) return;
    if (this.state.credentialExpired && Date.now() < this._credentialRetryAt) return;
    if (this._reconnectTimer) return;

    const delay = this._backoffMs;
    this._backoffMs = Math.min(this._backoffMs * 1.6, RECONNECT_MAX_MS);
    this.logEvent('reconnect_scheduled', { reason, delayMs: delay });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnectCount += 1;
      this.state.reconnectCount = this._reconnectCount;
      void this.connect(reason);
    }, delay);
  }

  attachSocketHandlers(socket) {
    if (!socket) return;
    this._socket = socket;
    socket.on('close', (code, reasonBuf) => {
      const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString() : String(reasonBuf || '');
      this.state.connected = false;
      this.state.authed = false;
      this.logEvent('ws_close', { code, reason });
      if (!this._stopped) this.scheduleReconnect(`close:${code}`);
    });
    socket.on('error', (err) => {
      this.state.lastError = err.message || String(err);
      this.logEvent('ws_error', { error: this.state.lastError });
      if (isCredentialError(err)) void this.markCredentialExpired(this.state.lastError, 'WS');
    });
  }

  async connect(trigger = 'start') {
    if (this._stopped) return;
    if (this.state.credentialExpired && Date.now() < this._credentialRetryAt) return;

    this.teardownSocket();
    this.logEvent('connecting', { trigger });

    try {
      this.client = new QianfanProtocolClient(this.shopConfig);
      if (this.shopConfig.lastSeq) this.client.setLastSeq(this.shopConfig.lastSeq);
      if (this.shopConfig.httpAuthHeaders) this.client.setHttpAuthHeaders(this.shopConfig.httpAuthHeaders);

      this.client._onFrame = (parsed) => this.onWsFrame(parsed);
      await this.client.ensureWsListenReady();

      this.client._listenActive = true;
      const sock = this.client.wsListen || this.client.ws;
      if (!sock || sock.readyState !== 1) {
        throw new Error('WS 未连接');
      }

      this.attachSocketHandlers(sock);
      this.state.connected = true;
      this.state.authed = Boolean(this.client.wsAuthed);
      if (this.state.authed) this.state.lastAuthAt = Date.now();
      this.state.credentialExpired = false;
      this.state.lastError = '';
      this._backoffMs = RECONNECT_MIN_MS;
      this.touchActivity();
      this.logEvent('connected', {
        authed: this.state.authed,
        channelId: this.client.wsChannelId || '',
      });
    } catch (err) {
      this.state.connected = false;
      this.state.authed = false;
      this.state.lastError = err.message || String(err);
      this.logEvent('connect_failed', { error: this.state.lastError, trigger });
      if (isCredentialError(err)) {
        await this.markCredentialExpired(this.state.lastError, 'WS');
        return;
      }
      this.scheduleReconnect('connect_failed');
    }
  }

  onWsFrame(parsed) {
    this.touchActivity();
    const action = String(parsed?.header?.action || '');
    if (action === 'ping' || action === 'auth') return;
    const msgs = extractBuyerMessagesFromWsPayload(parsed, this.shopTitle);
    for (const msg of msgs) {
      this.onBuyerMessage(msg, 'WS实时');
    }
  }

  async onBuyerMessage(message, source) {
    if (!message) return;
    if (!isWsBuyerCandidate(message)) return;
    const reasonRef = { value: '' };
    if (isIgnoredMessage(message, reasonRef)) return;

    const dedup = this.daemon.dedup.tryConsume(this.shopId, message);
    if (dedup.duplicate) return;

    this.state.lastMessageAt = Date.now();
    this.logEvent('buyer_message', {
      source,
      buyerNick: message.buyerNick,
      msgId: message.msgId,
      dedupKey: dedup.key,
    });

    await sendDaemonWxNotify(
      formatBuyerNotice({
        shopTitle: this.shopTitle,
        buyerNick: message.buyerNick,
        text: message.text,
        source,
        createAt: message.createAt,
      })
    );
  }

  async pollHttpHistory() {
    if (this._stopped || !this.client) return;
    const appCids = collectWatchAppCids(this.shopConfig);
    if (!appCids.length) return;

    this.state.lastHttpPollAt = Date.now();
    for (const appCid of appCids) {
      try {
        const page = await this.client.fetchMessageList(appCid, { cursor: -1, count: 20, limit: 20 });
        if (!page.ok) {
          const err = page.error || page.apiMsg || 'http_list_failed';
          if (isCredentialError(err)) {
            await this.markCredentialExpired(err, 'HTTP');
            return;
          }
          this.state.lastError = err;
          this.logEvent('http_poll_failed', { appCid, error: err });
          continue;
        }
        const buyerMsgs = (page.messages || []).filter((m) => !m.isSellerSide);
        for (const msg of buyerMsgs) {
          if (!isWsBuyerCandidate(msg)) continue;
          const reasonRef = { value: '' };
          if (isIgnoredMessage(msg, reasonRef)) continue;
          await this.onBuyerMessage(
            {
              ...msg,
              appCid: msg.appCid || appCid,
              shopTitle: this.shopTitle,
            },
            'HTTP兜底'
          );
        }
      } catch (err) {
        const text = err.message || String(err);
        this.state.lastError = text;
        this.logEvent('http_poll_error', { appCid, error: text });
        if (isCredentialError(text)) await this.markCredentialExpired(text, 'HTTP');
      }
    }
  }

  startHttpPollLoop() {
    const intervalMs = Number(this.daemon.options.httpPollMs || DEFAULT_HTTP_POLL_MS);
    const tick = () => {
      if (this._stopped) return;
      void this.pollHttpHistory();
    };
    this._httpPollTimer = setInterval(tick, intervalMs);
    setTimeout(tick, 5000);
  }

  stop() {
    this._stopped = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._httpPollTimer) clearInterval(this._httpPollTimer);
    if (this._activityTimer) clearTimeout(this._activityTimer);
    this.teardownSocket();
    this.logEvent('stopped');
  }

  async start() {
    this._stopped = false;
    await this.connect('start');
    this.startHttpPollLoop();
  }

  updateConfig(shopConfig, endpoints) {
    const configHash = crypto
      .createHash('md5')
      .update(JSON.stringify({ shopConfig, endpoints }))
      .digest('hex');
    if (this._configHash === configHash) return false;
    this._configHash = configHash;
    this.shopConfig = shopConfig;
    this.endpoints = endpoints;
    this.state.wsUrl = endpoints.listenUrl || endpoints.apppushUrl || '';
    this.state.canWsSend = Boolean(endpoints.canSend);
    this.state.credentialExpired = false;
    this._credentialRetryAt = 0;
    this.logEvent('config_updated');
    return true;
  }

  getStatus() {
    return {
      ...this.state,
      reconnectCount: this._reconnectCount,
    };
  }
}

class QianfanProtocolDaemon {
  constructor(options = {}) {
    this.options = {
      configPath: options.configPath || localConfigPath(),
      httpPollMs: Number(process.env.QIANFAN_PROTOCOL_HTTP_POLL_MS || options.httpPollMs || DEFAULT_HTTP_POLL_MS),
      activityTimeoutMs: Number(
        process.env.QIANFAN_PROTOCOL_ACTIVITY_TIMEOUT_MS || options.activityTimeoutMs || DEFAULT_ACTIVITY_TIMEOUT_MS
      ),
      useTapOnLoad: options.useTapOnLoad !== false,
      ...options,
    };
    this.workers = new Map();
    this.dedup = new MessageDedupStore();
    this.eventLog = [];
    this.startedAt = 0;
    this.configUpdatedAt = 0;
    this.running = false;
  }

  pushEvent(event) {
    this.eventLog.unshift(event);
    if (this.eventLog.length > MAX_EVENT_LOG) this.eventLog.length = MAX_EVENT_LOG;
    const line = `[protocol-daemon] ${event.kind} shop=${event.shopTitle || '-'} ${event.error || ''}`.trim();
    println(line);
  }

  _buildWorker(shopConfig) {
    let tapRows = [];
    if (this.options.useTapOnLoad) {
      try {
        const applied = applyTapToShopConfig(shopConfig, { shopTitle: shopConfig.shopTitle });
        shopConfig = applied.config;
        tapRows = applied.tapRows || [];
      } catch {
        // tap 可选
      }
    }
    const { config, endpoints } = enrichShopConfig(shopConfig, tapRows);
    const worker = new ShopWorker(config, this, { endpoints });
    return worker;
  }

  async loadConfig() {
    const shops = loadShopsFromConfigFile(this.options.configPath);
    try {
      const stat = fs.statSync(this.options.configPath);
      this.configUpdatedAt = stat.mtimeMs;
    } catch {
      // ignore
    }
    return shops;
  }

  async reloadConfig(reason = 'manual') {
    this.pushEvent({ at: Date.now(), kind: 'reload_start', reason });
    const shops = await this.loadConfig();
    const nextIds = new Set();
    for (const shop of shops) {
      const id = shopIdFromTitle(shop.shopTitle);
      nextIds.add(id);
      let worker = this.workers.get(id);
      if (!worker) {
        worker = this._buildWorker(shop);
        this.workers.set(id, worker);
        if (this.running) await worker.start();
        continue;
      }
      const applied = enrichShopConfig(shop);
      const changed = worker.updateConfig(applied.config, applied.endpoints);
      if (changed && this.running) {
        worker.stop();
        const fresh = this._buildWorker(applied.config);
        this.workers.set(id, fresh);
        await fresh.start();
      }
    }
    for (const [id, worker] of this.workers.entries()) {
      if (nextIds.has(id)) continue;
      worker.stop();
      this.workers.delete(id);
      this.pushEvent({ at: Date.now(), kind: 'shop_removed', shopTitle: worker.shopTitle });
    }
    this.pushEvent({ at: Date.now(), kind: 'reload_done', shopCount: this.workers.size, reason });
    return { ok: true, shopCount: this.workers.size };
  }

  async start() {
    if (this.running) return { ok: true, alreadyRunning: true };
    this.running = true;
    this.startedAt = Date.now();
    await this.reloadConfig('start');
    this.pushEvent({ at: Date.now(), kind: 'daemon_started', shopCount: this.workers.size });
    return { ok: true, shopCount: this.workers.size };
  }

  async stop() {
    this.running = false;
    for (const worker of this.workers.values()) worker.stop();
    this.pushEvent({ at: Date.now(), kind: 'daemon_stopped' });
  }

  getStatus() {
    const shops = [...this.workers.values()].map((w) => w.getStatus());
    return {
      ok: true,
      daemonRunning: this.running,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      configPath: this.options.configPath,
      configUpdatedAt: this.configUpdatedAt,
      shopCount: shops.length,
      shops,
      recentEvents: this.eventLog.slice(0, MAX_EVENT_LOG),
    };
  }

  async saveConfigFromUpload(shops) {
    const list = Array.isArray(shops) ? shops : [];
    const tmp = `${this.options.configPath}.upload.tmp`;
    fs.mkdirSync(require('path').dirname(this.options.configPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, this.options.configPath);
    try {
      const stat = fs.statSync(this.options.configPath);
      this.configUpdatedAt = stat.mtimeMs;
    } catch {
      // ignore
    }
    return this.reloadConfig('upload');
  }
}

module.exports = {
  QianfanProtocolDaemon,
  ShopWorker,
  loadShopsFromConfigFile,
  enrichShopConfig,
  shopIdFromTitle,
  isCredentialError,
};
