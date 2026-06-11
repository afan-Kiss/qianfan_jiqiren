const http = require('http');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { getDoudianConfig } = require('../../shared/config');
const { println } = require('../../shared/logger');
const { BRIDGE_EVENTS, DOUDIAN_EVENTS, createEnvelope } = require('./doudian-types');

const DEFAULT_IM_OPEN_GRACE_MS = 300000;

class DoudianWsServer {
  constructor(options = {}) {
    this.port = Number(options.port || getDoudianConfig().bridgePort || 19527);
    this.path = options.path || '/doudian/bridge';
    this.heartbeatTimeoutMs = Number(
      options.heartbeatTimeoutMs || getDoudianConfig().heartbeatTimeoutMs || 90000
    );
    this.server = null;
    this.wss = null;
    this.bridges = new Map();
    this.handlers = new Map();
    this.heartbeatTimer = null;
    this.started = false;
    this.lastError = '';
  }

  on(eventType, handler) {
    if (!this.handlers.has(eventType)) this.handlers.set(eventType, new Set());
    this.handlers.get(eventType).add(handler);
    return () => this.handlers.get(eventType)?.delete(handler);
  }

  emitLocal(eventType, envelope) {
    const set = this.handlers.get(eventType);
    if (!set?.size) return;
    for (const fn of [...set]) {
      try {
        fn(envelope);
      } catch (err) {
        println(`事件处理异常 type=${eventType} ${err.message || err}`);
      }
    }
    const wildcard = this.handlers.get('*');
    if (wildcard?.size) {
      for (const fn of [...wildcard]) {
        try {
          fn(envelope);
        } catch {
          // ignore
        }
      }
    }
  }

  broadcastToBridge(bridgeId, envelope) {
    const conn = this.findConnByBridgeId(bridgeId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;
    conn.ws.send(JSON.stringify(envelope));
    return true;
  }

  findConnByBridgeId(bridgeId) {
    if (!bridgeId) return null;
    if (this.bridges.has(bridgeId)) return this.bridges.get(bridgeId);
    for (const conn of this.bridges.values()) {
      if (conn.clientBridgeId === bridgeId || conn.bridgeId === bridgeId) return conn;
    }
    return null;
  }

  sendDebugCommand(clientBridgeId, commandType, payload = {}) {
    const conn = this.findConnByBridgeId(clientBridgeId);
    if (conn) {
      conn.lastHeartbeatAt = Date.now();
      if (commandType === 'debug.open_im_workspace') {
        conn.imOpenCommandAt = Date.now();
      }
    }
    return this.broadcastToBridge(
      clientBridgeId,
      createEnvelope(commandType, { bridgeId: clientBridgeId, payload })
    );
  }

  sendToBridge(bridgeId, type, fields = {}) {
    return this.broadcastToBridge(bridgeId, createEnvelope(type, { bridgeId, ...fields }));
  }

  getBridgeIds() {
    return [...this.bridges.keys()];
  }

  isOpenCommandBridgeUrl(url = '') {
    const u = String(url).toLowerCase();
    return (
      /homepage|mshop\/homepage|ffa\/mshop/.test(u) ||
      /ffa\/empty/.test(u) ||
      /fxg\.jinritemai\.com\/ffa\//.test(u)
    );
  }

  getLiveOpenCommandTargets() {
    const out = [];
    for (const conn of this.bridges.values()) {
      if (conn.ws.readyState !== WebSocket.OPEN) continue;
      const id = conn.clientBridgeId || conn.bridgeId;
      if (!id) continue;
      if (this.isOpenCommandBridgeUrl(conn.pageUrl)) out.push(id);
    }
    return [...new Set(out)];
  }

  hasLiveOpenCommandTarget() {
    return this.getLiveOpenCommandTargets().length > 0;
  }

  isBridgeConnected(bridgeId) {
    const conn = this.findConnByBridgeId(bridgeId);
    return Boolean(conn && conn.ws.readyState === WebSocket.OPEN);
  }

  getBridgeState(bridgeId) {
    const conn = this.bridges.get(bridgeId);
    if (!conn) return null;
    return {
      bridgeId,
      connectedAt: conn.connectedAt,
      lastHeartbeatAt: conn.lastHeartbeatAt,
      pageUrl: conn.pageUrl,
      pageTitle: conn.pageTitle,
      shopId: conn.shopId,
      shopName: conn.shopName,
      ready: conn.ready,
    };
  }

  getPrimaryBridge() {
    const list = [...this.bridges.values()].filter((b) => b.ready);
    if (!list.length) return null;
    list.sort((a, b) => b.lastHeartbeatAt - a.lastHeartbeatAt);
    return list[0];
  }

  async start() {
    if (this.started) return { ok: true, already: true, port: this.port };

    const { ensurePortAvailable } = require('../../shared/port-guard');
    this.lastPortGuard = await ensurePortAvailable({
      port: this.port,
      host: '127.0.0.1',
      killExisting: true,
      processNameAllowList: ['node.exe'],
      timeoutMs: 10000,
    });
    if (!this.lastPortGuard.success) {
      this.lastError = this.lastPortGuard.reason || 'port_guard_failed';
      const err = new Error(`port_guard_failed:${this.lastError}`);
      err.portGuard = this.lastPortGuard;
      throw err;
    }

    await new Promise((resolve, reject) => {
      this.server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('doudian bridge server');
      });

      this.wss = new WebSocketServer({ server: this.server, path: this.path });

      this.wss.on('connection', (ws, req) => {
        const bridgeId = crypto.randomBytes(8).toString('hex');
        const conn = {
          ws,
          bridgeId,
          clientBridgeId: '',
          connectedAt: Date.now(),
          lastHeartbeatAt: Date.now(),
          ready: false,
          pageUrl: '',
          pageTitle: '',
          shopId: '',
          shopName: '',
        };
        this.bridges.set(bridgeId, conn);
        println(`bridge 已连接 bridgeId=${bridgeId} remote=${req.socket.remoteAddress || ''}`);

        ws.on('message', (data) => {
          this.handleBridgeMessage(conn, data);
        });

        ws.on('close', () => {
          const keys = new Set(
            [bridgeId, conn.clientBridgeId, conn.bridgeId].filter(Boolean)
          );
          for (const key of keys) this.bridges.delete(key);
          println(`bridge 断开 bridgeId=${conn.clientBridgeId || conn.bridgeId || bridgeId}`);
          this.emitLocal(DOUDIAN_EVENTS.RUNTIME_STATUS, createEnvelope(DOUDIAN_EVENTS.RUNTIME_STATUS, {
            bridgeId,
            payload: { event: 'bridge_disconnected' },
          }));
        });

        ws.on('error', (err) => {
          this.lastError = String(err.message || err);
          println(`bridge 错误 bridgeId=${bridgeId} ${this.lastError}`);
        });

        ws.send(
          JSON.stringify(
            createEnvelope(BRIDGE_EVENTS.HELLO, {
              bridgeId,
              payload: { server: 'doudian-ws-server', path: this.path },
            })
          )
        );
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.started = true;
        println(`本地 WebSocket 服务已启动 ws://127.0.0.1:${this.port}${this.path}`);
        this.startHeartbeatWatch();
        resolve();
      });

      this.server.on('error', (err) => {
        this.lastError = String(err.message || err);
        reject(err);
      });
    });

    return { ok: true, port: this.port, path: this.path };
  }

  handleBridgeMessage(conn, raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      println(`收到非 JSON 消息 bridgeId=${conn.bridgeId}`);
      return;
    }

    if (msg.platform && msg.platform !== 'doudian') return;

    conn.lastHeartbeatAt = Date.now();
    if (msg.bridgeId) {
      if (conn.clientBridgeId !== msg.bridgeId) {
        for (const [key, c] of this.bridges.entries()) {
          if (c === conn) {
            this.bridges.delete(key);
            break;
          }
        }
      }
      conn.clientBridgeId = msg.bridgeId;
      conn.bridgeId = msg.bridgeId;
      this.bridges.set(msg.bridgeId, conn);
    }

    const pageHref = msg.payload?.href || msg.payload?.url || '';
    if (pageHref) conn.pageUrl = pageHref;
    if (msg.payload?.title) conn.pageTitle = msg.payload.title;

    if (msg.type === BRIDGE_EVENTS.HELLO) {
      println(`bridge.hello bridgeId=${conn.bridgeId} url=${msg.payload?.url || msg.payload?.href || ''}`);
    }

    if (msg.type === BRIDGE_EVENTS.READY) {
      conn.ready = true;
      conn.pageUrl = msg.payload?.pageUrl || msg.raw?.pageUrl || conn.pageUrl;
      conn.pageTitle = msg.payload?.pageTitle || msg.raw?.pageTitle || conn.pageTitle;
      conn.shopId = msg.shopId || msg.payload?.shopId || '';
      conn.shopName = msg.shopName || msg.payload?.shopName || '';
      println(`bridge.ready bridgeId=${conn.bridgeId} url=${conn.pageUrl}`);
    }

    if (msg.type === BRIDGE_EVENTS.HEARTBEAT) {
      // heartbeat tracked via lastHeartbeatAt
    }

    if (msg.type === BRIDGE_EVENTS.ERROR) {
      this.lastError = String(msg.payload?.message || msg.payload?.error || 'bridge_error');
      println(`bridge.error bridgeId=${conn.bridgeId} ${this.lastError}`);
    }

    if (msg.type === DOUDIAN_EVENTS.MESSAGE_INBOUND) {
      println(`收到买家消息 bridgeId=${conn.bridgeId} conversationId=${msg.conversationId || ''} messageId=${msg.messageId || ''}`);
    }

    if (
      msg.type === DOUDIAN_EVENTS.AFTERSALE_NEED_HANDLE ||
      msg.type === DOUDIAN_EVENTS.AFTERSALE_CREATED ||
      msg.type === DOUDIAN_EVENTS.AFTERSALE_UPDATED
    ) {
      println(`收到售后事件 bridgeId=${conn.bridgeId} type=${msg.type} aftersaleId=${msg.payload?.aftersaleId || ''}`);
    }

    this.emitLocal(msg.type, msg);
    this.emitLocal('*', msg);
  }

  startHeartbeatWatch() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [bridgeId, conn] of this.bridges) {
        if (conn.ws.readyState !== WebSocket.OPEN) {
          this.bridges.delete(bridgeId);
          continue;
        }

        const staleMs = now - conn.lastHeartbeatAt;
        const isOpenCommandBridge = this.isOpenCommandBridgeUrl(conn.pageUrl);
        const inOpenCampaign =
          conn.imOpenCommandAt && now - conn.imOpenCommandAt < DEFAULT_IM_OPEN_GRACE_MS;

        // homepage/empty bridge 在 IM 打开流程中不因心跳超时被服务端主动断开
        if (isOpenCommandBridge || inOpenCampaign) {
          continue;
        }

        if (staleMs > this.heartbeatTimeoutMs) {
          println(`bridge 心跳超时 bridgeId=${bridgeId}`);
          try {
            conn.ws.close();
          } catch {
            // ignore
          }
          const keys = new Set(
            [bridgeId, conn.clientBridgeId, conn.bridgeId].filter(Boolean)
          );
          for (const key of keys) this.bridges.delete(key);
          this.emitLocal(DOUDIAN_EVENTS.RUNTIME_STATUS, createEnvelope(DOUDIAN_EVENTS.RUNTIME_STATUS, {
            bridgeId: conn.clientBridgeId || bridgeId,
            payload: { event: 'heartbeat_timeout' },
          }));
        }
      }
    }, Math.max(5000, Math.floor(this.heartbeatTimeoutMs / 3)));
  }

  async stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const conn of this.bridges.values()) {
      try {
        conn.ws.close();
      } catch {
        // ignore
      }
    }
    this.bridges.clear();

    await new Promise((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });

    await new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });

    this.started = false;
    this.lastPortGuard = null;
    println('本地 WebSocket 服务已停止');
  }
}

let singleton = null;

function getDoudianWsServer(options) {
  if (!singleton) singleton = new DoudianWsServer(options);
  return singleton;
}

module.exports = {
  DoudianWsServer,
  getDoudianWsServer,
  DEFAULT_IM_OPEN_GRACE_MS,
};
