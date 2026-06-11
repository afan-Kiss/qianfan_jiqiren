const { getDoudianConfig, getHistorySyncConfig } = require('../../shared/config');
const { println } = require('../../shared/logger');
const { ensureDebugClientReady } = require('../../services/runtime/ensure-debug-client-ready');
const { HistorySyncManager } = require('../../services/history/history-sync-manager');
const { CdpBridgeService } = require('../../services/cdp/cdp-bridge-service');
const { probeCdpRoute } = require('./doudian-cdp-probe');
const { detectDoudianProcesses } = require('./doudian-process-detector');
const { findDoudianPages } = require('./doudian-page-finder');
const { getDoudianWsServer } = require('./doudian-ws-server');
const { findAndInject } = require('./doudian-injector');
const { tryAsarInject, getPatchStatus } = require('./doudian-asar-injector');
const { DoudianMessageListener } = require('./doudian-message-listener');
const { DoudianMessageSender } = require('./doudian-message-sender');
const { DoudianAftersaleListener } = require('./doudian-aftersale-listener');
const { DoudianOrderContext } = require('./doudian-order-context');
const { DoudianDedupe } = require('./doudian-dedupe');
const { createRuntimeStatus, DOUDIAN_EVENTS, BRIDGE_EVENTS, createEnvelope, INJECTION_ROUTES } = require('./doudian-types');

class DoudianRuntime {
  constructor(options = {}) {
    this.options = options;
    this.started = false;
    this.starting = false;
    this.status = createRuntimeStatus();
    this.wsServer = null;
    this.messageListener = null;
    this.messageSender = null;
    this.aftersaleListener = null;
    this.orderContext = null;
    this.dedupe = new DoudianDedupe();
    this.injectResult = null;
    this.cdpProbe = null;
    this.asarResult = null;
    this.processReport = null;
    this.statusListeners = new Set();
    this.reconnectTimer = null;
    this.clientRuntime = null;
    this.historySyncResult = null;
    this.cdpBridgeService = null;
  }

  onStatus(listener) {
    if (typeof listener !== 'function') return () => {};
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => this.statusListeners.delete(listener);
  }

  emitStatus(patch = {}) {
    this.status = createRuntimeStatus({ ...this.status, ...patch });
    for (const fn of this.statusListeners) {
      try {
        fn(this.getStatus());
      } catch {
        // ignore
      }
    }
    if (this.wsServer) {
      this.wsServer.emitLocal(
        DOUDIAN_EVENTS.RUNTIME_STATUS,
        createEnvelope(DOUDIAN_EVENTS.RUNTIME_STATUS, {
          payload: this.getStatus(),
        })
      );
    }
  }

  getStatus() {
    const bridge = this.wsServer?.getPrimaryBridge();
    const cfg = getDoudianConfig();
    const patchStatus = cfg.installDir ? getPatchStatus(cfg.installDir) : { patched: false };
    return createRuntimeStatus({
      ...this.status,
      doudianBridgeConnected: Boolean(bridge),
      lastHeartbeatAt: bridge?.lastHeartbeatAt || this.status.lastHeartbeatAt || 0,
      bridgeId: bridge?.bridgeId || this.status.bridgeId || '',
      pageTitle: bridge?.pageTitle || this.status.pageTitle || '',
      pageUrl: bridge?.pageUrl || this.status.pageUrl || '',
      devtoolsPort: this.cdpProbe?.scan?.best?.port || this.status.devtoolsPort || 0,
      installDir: cfg.installDir || '',
      asarPatched: patchStatus.patched,
      doudianListenerReady: Boolean(this.messageListener?.ready),
      doudianSenderReady: Boolean(this.messageSender?.ready),
      doudianAftersaleReady: Boolean(this.aftersaleListener?.ready),
    });
  }

  startCoreServices() {
    this.messageListener = new DoudianMessageListener({
      wsServer: this.wsServer,
      dedupe: this.dedupe,
      onInboundMessage: this.options.onInboundMessage,
      onUiNotify: this.options.onUiNotify,
    });
    this.messageSender = new DoudianMessageSender({ wsServer: this.wsServer });
    this.aftersaleListener = new DoudianAftersaleListener({
      wsServer: this.wsServer,
      onAftersale: this.options.onAftersale,
      onUiNotify: this.options.onUiNotify,
    });
    this.orderContext = new DoudianOrderContext({
      wsServer: this.wsServer,
      onOrderContext: this.options.onOrderContext,
    });

    this.messageListener.start();
    this.messageSender.start();
    this.aftersaleListener.start();
    this.orderContext.start();
  }

  async start() {
    if (this.started) return { ok: true, already: true, status: this.getStatus() };
    if (this.starting) return { ok: false, reason: 'starting_in_progress' };
    this.starting = true;

    const cfg = getDoudianConfig();
    if (!cfg.enabled && !this.options.force) {
      this.starting = false;
      return { ok: false, reason: 'disabled' };
    }

    try {
      println('抖店桥启动');

      this.processReport = detectDoudianProcesses();
      this.emitStatus({ doudianClientFound: this.processReport.found });

      this.clientRuntime = await ensureDebugClientReady();
      this.emitStatus({
        clientRuntimeReady: this.clientRuntime.ready,
        reusedExistingClient: this.clientRuntime.reusedExistingClient,
        killedExistingClient: this.clientRuntime.killedExistingClient,
        relaunchedClient: this.clientRuntime.relaunchedClient,
        devtoolsPort: this.clientRuntime.devtoolsPort || 0,
      });

      const historyCfg = getHistorySyncConfig();
      if (historyCfg.enabled && historyCfg.runOnStartup) {
        try {
          const historyManager = new HistorySyncManager();
          this.historySyncResult = await historyManager.runSync({ listenMs: 8000 });
          this.emitStatus({
            historySyncStatus: this.historySyncResult.status,
            historyReady: this.historySyncResult.results?.insertedMessages > 0,
          });
        } catch (err) {
          this.emitStatus({ historySyncStatus: 'failed', historyReady: false, lastError: String(err.message || err) });
        }
      }

      this.wsServer = getDoudianWsServer({ port: cfg.bridgePort });
      await this.wsServer.start();
      this.bindWsServerEvents();
      this.startCoreServices();

      const injectOutcome = await this.tryDualRouteInject();
      this.injectResult = injectOutcome;

      if (this.clientRuntime?.ready) {
        try {
          this.cdpBridgeService = new CdpBridgeService();
          await this.cdpBridgeService.start({ listenMs: 0 });
        } catch (err) {
          println(`CDP bridge 启动警告：${err.message || err}`);
        }
      }

      this.started = true;
      this.emitStatus({
        doudianListenerReady: true,
        doudianSenderReady: true,
        doudianAftersaleReady: true,
      });

      println('抖店桥已启动');
      return {
        ok: true,
        status: this.getStatus(),
        injectResult: this.injectResult,
        cdpProbe: this.cdpProbe,
        asarResult: this.asarResult,
      };
    } catch (err) {
      const msg = String(err.message || err);
      this.emitStatus({ lastError: msg });
      println(`抖店桥启动失败：${msg}`);
      return { ok: false, error: msg };
    } finally {
      this.starting = false;
    }
  }

  async tryDualRouteInject() {
    const cfg = getDoudianConfig();
    if (!cfg.autoInjectOnStart && !this.options.autoInject) {
      return { ok: false, reason: 'auto_inject_disabled' };
    }

    this.cdpProbe = await probeCdpRoute({ stopOnFirstDoudian: false });
    this.emitStatus({
      cdpAvailable: this.cdpProbe.available,
      devtoolsPort: this.cdpProbe.scan?.best?.port || 0,
    });

    if (this.cdpProbe.canInject) {
      println('走路线：CDP');
      this.emitStatus({ injectionRoute: INJECTION_ROUTES.CDP, doudianPageFound: true });
      const devtools = this.cdpProbe.scan.best;
      const pageReport = findDoudianPages(devtools.pages || devtools.list || [], {
        devtoolsPort: devtools.port,
      });
      this.emitStatus({ doudianPageFound: Boolean(pageReport.bestServicePage) });

      const result = await findAndInject({
        devtools,
        wsServer: this.wsServer,
        pageInfo: pageReport.priorityServicePage || pageReport.bestServicePage,
      });

      if (result.ok) {
        this.emitStatus({
          doudianBridgeInjected: true,
          bridgeId: result.bridgeId,
          pageTitle: result.title,
          pageUrl: result.url,
          lastError: '',
        });
      } else {
        this.emitStatus({ lastError: result.reason || result.error || 'cdp_inject_failed' });
      }
      return { route: INJECTION_ROUTES.CDP, ...result };
    }

    if (this.cdpProbe.available) {
      println('CDP 端口可用但未发现抖店客服页，切换 asar 分析路线');
    } else {
      println('未发现 DevTools 监听端口，切换 asar 分析路线');
    }

    const installDir = cfg.installDir || this.options.installDir;
    if (!installDir) {
      const msg = '未配置 installDir，无法走 asar 路线';
      println(msg);
      this.emitStatus({
        injectionRoute: INJECTION_ROUTES.ASAR_ANALYSIS,
        lastError: 'install_dir_missing',
      });
      return { ok: false, reason: 'install_dir_missing', route: INJECTION_ROUTES.ASAR };
    }

    this.asarResult = await tryAsarInject(installDir, {
      wsServer: this.wsServer,
      cdpHint: this.cdpProbe,
      forcePatch: this.options.forcePatch,
    });

    this.emitStatus({
      injectionRoute: INJECTION_ROUTES.ASAR,
      asarAnalyzed: true,
      asarPatched: Boolean(this.asarResult.patchResult?.ok || this.asarResult.phase === 'bridge_connected'),
      doudianPageFound: true,
      lastError: this.asarResult.ok ? '' : this.asarResult.reason || '',
    });

    if (this.asarResult.ok && this.asarResult.bridgeId) {
      this.emitStatus({
        doudianBridgeInjected: true,
        doudianBridgeConnected: true,
        bridgeId: this.asarResult.bridgeId,
      });
    }

    return this.asarResult;
  }

  bindWsServerEvents() {
    if (!this.wsServer) return;

    this.wsServer.on(BRIDGE_EVENTS.HEARTBEAT, () => {
      this.emitStatus({ lastHeartbeatAt: Date.now(), doudianBridgeConnected: true });
    });

    this.wsServer.on(BRIDGE_EVENTS.READY, (envelope) => {
      this.emitStatus({
        doudianBridgeInjected: true,
        doudianBridgeConnected: true,
        bridgeId: envelope.bridgeId,
        pageTitle: envelope.payload?.pageTitle || '',
        pageUrl: envelope.payload?.pageUrl || '',
        lastHeartbeatAt: Date.now(),
        lastError: '',
      });
    });

    this.wsServer.on(BRIDGE_EVENTS.ERROR, (envelope) => {
      this.emitStatus({ lastError: envelope.payload?.message || 'bridge_error' });
    });

    this.wsServer.on('*', (envelope) => {
      if (envelope.type === DOUDIAN_EVENTS.RUNTIME_LOG) {
        const level = envelope.payload?.level || 'info';
        println(`[bridge-log/${level}] ${envelope.payload?.message || ''}`);
      }
    });
  }

  async inject(options = {}) {
    if (!this.wsServer) await this.start();
    this.options.autoInject = true;
    return this.tryDualRouteInject();
  }

  async reconnect() {
    println('正在重连');
    await this.stop({ soft: true });
    const result = await this.start();
    if (result.ok) println('已恢复');
    return result;
  }

  scheduleReconnect(delayMs = 5000) {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.reconnect();
    }, delayMs);
  }

  async sendText(task) {
    if (!this.messageSender?.ready) throw new Error('发送器未就绪');
    return this.messageSender.sendTextTask(task);
  }

  async stop(options = {}) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.messageListener?.stop();
    this.messageSender?.stop();
    this.aftersaleListener?.stop();
    this.orderContext?.stop();

    if (!options.soft) {
      await this.cdpBridgeService?.stop();
      this.cdpBridgeService = null;
      await this.wsServer?.stop();
      this.wsServer = null;
    }

    this.started = false;
    this.emitStatus({
      doudianBridgeConnected: false,
      doudianBridgeInjected: false,
      doudianListenerReady: false,
      doudianSenderReady: false,
      doudianAftersaleReady: false,
    });
    println('抖店桥已停止');
    return { ok: true };
  }
}

let runtimeSingleton = null;

function getDoudianRuntime(options) {
  if (!runtimeSingleton) runtimeSingleton = new DoudianRuntime(options);
  return runtimeSingleton;
}

module.exports = {
  DoudianRuntime,
  getDoudianRuntime,
};
