const { getCdpBridgeConfig } = require('../../shared/config');
const { bridgeLog } = require('../../shared/bridge-log');
const { detectDevToolsPort } = require('./cdp-port-detector');
const { discoverTargets } = require('./cdp-target-manager');
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
    const portDetect = await detectDevToolsPort();
    this.state.devtoolsPortOk = portDetect.ok;
    this.state.devtoolsPort = portDetect.port || 0;
    this.db.setStatus('devtools_port_ok', String(portDetect.ok));

    if (!portDetect.ok) {
      this.state.lastError = portDetect.reason || 'no_devtools_port';
      this.db.insertError('cdp-port-detector', 'no devtools port', portDetect.reason);
      return buildBridgeHealth(this.state);
    }

    const discovered = await discoverTargets({ port: portDetect.port, host: portDetect.host });
    this.state.targets = discovered.targets;
    this.state.targetCount = discovered.targets.length;
    this.db.setStatus('target_count', String(discovered.targets.length));

    if (!discovered.ok) {
      this.state.lastError = discovered.reason || 'no_targets';
      this.db.insertError('cdp-target-manager', 'no matching targets', discovered.reason);
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
