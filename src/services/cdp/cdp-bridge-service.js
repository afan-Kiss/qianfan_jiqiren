const { getCdpBridgeConfig } = require('../../shared/config');
const { bridgeLog } = require('../../shared/bridge-log');
const { ensureDebugClientReady } = require('../runtime/ensure-debug-client-ready');
const { CdpClient } = require('./cdp-client');
const { injectHook } = require('./cdp-injector');
const { attachNetworkObserver } = require('./cdp-network-observer');
const { WsFrameRouter } = require('../bridge/ws-frame-router');
const { MessageExtractor } = require('../bridge/message-extractor');
const { BridgeDb } = require('../bridge/bridge-db');
const { buildBridgeHealth } = require('../bridge/bridge-health');

class CdpBridgeService {
  constructor(options = {}) {
    const cfg = getCdpBridgeConfig();
    this.cfg = cfg;
    this.db = options.db || new BridgeDb();
    this.extractor = new MessageExtractor();
    this.router = new WsFrameRouter({
      db: this.db,
      extractor: this.extractor,
      debugPayload: cfg.debugPayload,
      saveRawFrames: cfg.saveRawFrames,
      savePayloadMaxLength: cfg.savePayloadMaxLength,
      onBusiness: () => this.noteBusiness(),
    });
    this.clients = [];
    this.observers = [];
    this.state = {
      devtoolsPortOk: false,
      devtoolsPort: 0,
      cdpConnected: false,
      targetCount: 0,
      injectedCount: 0,
      wsConnectionCount: 0,
      lastFrameAt: '',
      lastBusinessAt: '',
      lastError: '',
      frameCount: 0,
      businessCount: 0,
      targets: [],
      connections: [],
      errors: [],
    };
  }

  noteFrame() {
    this.state.frameCount += 1;
    this.state.lastFrameAt = new Date().toISOString();
    this.db.setStatus('last_frame_at', this.state.lastFrameAt);
  }

  noteBusiness() {
    this.state.businessCount += 1;
    this.state.lastBusinessAt = new Date().toISOString();
    this.db.setStatus('last_business_at', this.state.lastBusinessAt);
  }

  async attachTarget(target) {
    const client = new CdpClient({
      wsUrl: target.webSocketDebuggerUrl,
      targetId: target.targetId,
      label: target.title || target.targetId,
    });

    await client.connect();
    this.state.cdpConnected = true;

    client.on((event) => {
      if (event.type === 'event' && event.method === 'Runtime.bindingCalled') {
        try {
          const payload = JSON.parse(event.params.payload || '{}');
          const row = this.router.route({
            source: 'inject-hook',
            kind: payload.kind || 'ws_frame',
            direction: payload.direction || 'unknown',
            targetId: target.targetId,
            socketId: payload.socketId || '',
            url: payload.url || '',
            payloadType: payload.payloadType,
            payloadText: payload.payloadText,
            payloadBase64: payload.payloadBase64,
            pageTitle: target.pageTitle,
            pageUrl: target.pageUrl,
            shopId: target.shopId,
            shopName: target.shopName,
            timestamp: payload.timestamp || Date.now(),
          });
          if (row) this.noteFrame();
        } catch (err) {
          this.state.lastError = String(err.message || err);
          this.db.insertError('inject-hook', 'bindingCalled parse failed', err.message, target.targetId);
        }
      }
    });

    const injectResult = await injectHook(client, {
      target,
      injectOnNewDocument: this.cfg.injectOnNewDocument,
    });
    if (injectResult.ok) this.state.injectedCount += 1;

    let observer = null;
    if (this.cfg.enableNetworkObserver) {
      const routerWrap = {
        route: (row) => {
          const routed = this.router.route(row);
          if (routed) {
            this.noteFrame();
            this.state.wsConnectionCount = this.router.stats.connections;
          }
        },
      };
      observer = attachNetworkObserver(client, routerWrap, target);
      await observer.enable();
      this.observers.push(observer);
    }

    this.clients.push(client);
    return { client, injectResult, observer };
  }

  async start(options = {}) {
    const listenMs = Number(options.listenMs || 15000);
    const clientReady = options.clientReady || (await ensureDebugClientReady(options));
    this.state.clientRuntime = clientReady;
    this.state.devtoolsPortOk = Boolean(clientReady.devtoolsPort);
    this.state.devtoolsPort = clientReady.devtoolsPort || 0;
    this.db.setStatus('devtools_port_ok', String(this.state.devtoolsPortOk));

    if (!clientReady.ready) {
      this.state.lastError = clientReady.reason || 'client_not_ready';
      this.db.insertError('cdp-bridge-service', 'client not ready', clientReady.message || clientReady.reason);
      return buildBridgeHealth(this.state);
    }

    const discovered = {
      ok: true,
      targets: clientReady.matchedTargets || [],
    };
    this.state.targets = discovered.targets;
    this.state.targetCount = discovered.targets.length;
    this.db.setStatus('target_count', String(discovered.targets.length));

    if (!discovered.targets.length) {
      this.state.lastError = 'no_matching_targets';
      this.db.insertError('cdp-target-manager', 'no matching targets', 'no_targets');
      return buildBridgeHealth(this.state);
    }

    for (const target of discovered.targets.slice(0, 5)) {
      try {
        await this.attachTarget(target);
      } catch (err) {
        this.state.lastError = String(err.message || err);
        bridgeLog('[BRIDGE_ERROR]', 'attachTarget failed', err.message);
        this.db.insertError('cdp-bridge-service', 'attachTarget failed', err.message, target.targetId);
      }
    }

    if (listenMs > 0) {
      bridgeLog('[CDP_CONNECT]', `监听 WebSocket 帧 ${Math.round(listenMs / 1000)}s ...`);
      await new Promise((r) => setTimeout(r, listenMs));
    }

    this.state.connections = this.db.getConnections(20);
    this.state.errors = this.db.getErrors(10);
    this.state.frameCount = this.db.countFrames();
    return buildBridgeHealth(this.state);
  }

  async stop() {
    for (const obs of this.observers) {
      try {
        obs.dispose();
      } catch {
        // ignore
      }
    }
    for (const c of this.clients) {
      try {
        await c.close();
      } catch {
        // ignore
      }
    }
    this.clients = [];
    this.observers = [];
  }

  getReport() {
    return {
      health: buildBridgeHealth(this.state),
      recentFrames: this.router.getRecentFrames(20).length
        ? this.router.getRecentFrames(20)
        : this.db.getRecentFrames(20),
      recentBusiness: this.router.getRecentBusiness(20).length
        ? this.router.getRecentBusiness(20)
        : this.db.getRecentBusiness(20),
      connections: this.db.getConnections(20),
      errors: this.db.getErrors(20),
      stats: this.router.stats,
    };
  }
}

module.exports = {
  CdpBridgeService,
};
