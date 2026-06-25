/**
 * 单进程中转服务：微信 + 千帆监听 + 引用回复（Electron / CLI 共用）
 */
const EventEmitter = require('events');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const config = require('./wechat/wxbot-new-config');
const { checkWxbotHealth } = require('./wxbot-new-health');
const { startWxbotCallbackServer } = require('./wxbot-new-callback-server');
const { createWechatToQianfanDispatcher } = require('./wechat-to-qianfan-reply');
const { syncWxbotCallbackConfig } = require('./wxbot-new-api');
const { createQianfanRuntimeController } = require('./adapters/qianfan-runtime-controller');
const { startQianfanMessageListener } = require('./qianfan-message-listener');
const { createQianfanWechatNotifier } = require('./qianfan-wechat-notifier');
const { runStartupLogMaintenance } = require('./log-maintenance');
const { shouldLogCallback } = require('./wxbot-new-callback-log');
const { println } = require('./utils');
const { computeRuntimeHealth } = require('./shared/runtime-health');

const { isListenerRunning, setListenerHandle, clearListenerHandle, getListenerHandle } = require('./listener-state');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function killExistingWechat() {
  if (!config.oneClick?.autoKillExistingWechat) return;
  for (const proc of ['Weixin.exe', 'WeChat.exe', 'wxbot.exe']) {
    try {
      execSync(`taskkill /F /IM ${proc}`, { stdio: 'ignore' });
    } catch {
      // ignore
    }
  }
}

function startWxbotExe() {
  spawn(config.wxbotExe, [], {
    cwd: config.wxbotRuntimeDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  }).unref();
}

class RelayService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.cliMode = options.cli === true;
    this.status = 'stopped';
    this.lastError = '';
    this.wechatReady = false;
    this.qianfanReady = false;
    this.listenerReady = false;
    this.hookConnected = false;
    this.recentLogs = [];
    this.callbackServer = null;
    this.replyDispatcher = null;
    this.qianfanController = null;
    this.startPromise = null;
    this.notifyAccountCount = 0;
  }

  log(level, message, extra = {}) {
    const entry = {
      level: level || 'info',
      message: String(message || ''),
      workerName: extra.workerName || 'relay',
      time: Date.now(),
    };
    this.recentLogs.push(entry);
    if (this.recentLogs.length > 200) this.recentLogs.shift();
    this.emit('log', entry);
    if (this.cliMode) {
      println(entry.message);
    }
  }

  emitStatus() {
    const snapshot = this.getStatus();
    this.emit('status', snapshot);
    return snapshot;
  }

  getStatus() {
    const relayRunning = ['starting', 'running', 'degraded'].includes(this.status);
    const raw = {
      supervisorStatus: this.status,
      relayRunning,
      qianfanReady: this.qianfanReady,
      listenerReady: this.listenerReady,
      wechatReady: this.wechatReady,
      hookConnected: this.hookConnected,
      lastError: this.lastError,
      recentLogs: this.recentLogs.slice(-80),
      notifyAccountCount: this.notifyAccountCount,
    };
    return {
      ...raw,
      health: computeRuntimeHealth(raw, { notifyAccountCount: this.notifyAccountCount }),
    };
  }

  async waitForWechatInjection() {
    const interval = config.oneClick?.healthCheckIntervalMs || 2000;
    while (true) {
      if (this.status === 'stopped') throw new Error('relay stopped');
      const report = await checkWxbotHealth();
      if (report.ok) return report;
      if (report.wrongLoginWxid) return report;
      await sleep(interval);
    }
  }

  async startListener(attachResult) {
    if (!attachResult?.canStartListener) {
      throw new Error('千帆店铺页面未就绪，无法启动监听');
    }

    const qianfanCfg = this.qianfanController.getConfig();
    const notifier = createQianfanWechatNotifier({ enabled: true });
    const handle = await startQianfanMessageListener({
      devtoolsPort: qianfanCfg.devtoolsPort,
      devtoolsHost: qianfanCfg.devtoolsHost,
      expectedShopCount: qianfanCfg.expectedShopCount,
      shopReport: attachResult.shopReport,
      pages: attachResult.shopReport?.shops,
      onBuyerMessage: (message, options) => {
        try {
          notifier.handleBuyerMessage(message, options);
        } catch (err) {
          this.log('error', `[千帆] 通知处理失败：${err.message || err}`);
        }
      },
    });
    setListenerHandle(handle);
    this.listenerReady = true;
    this.qianfanReady = true;
    this.log('info', '[千帆] 监听已启动，等待买家消息…');
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (['starting', 'running', 'degraded'].includes(this.status)) {
      return { ok: true, alreadyRunning: true, status: this.getStatus() };
    }

    this.startPromise = this._startInternal();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async _startInternal() {
    if (!fs.existsSync(config.wxbotExe)) {
      const msg = `未找到 wxbot.exe：${config.wxbotExe}`;
      this.lastError = msg;
      return { ok: false, message: msg };
    }

    this.status = 'starting';
    this.lastError = '';
    this.wechatReady = false;
    this.qianfanReady = false;
    this.listenerReady = false;
    this.hookConnected = false;
    this.emitStatus();

    try {
      runStartupLogMaintenance();
      killExistingWechat();

      this.qianfanController = createQianfanRuntimeController({
        config: { ...config.qianfanDebug, root: config.root },
        log: (level, message) => this.log(level, message, { workerName: 'qianfan' }),
      });

      const qianfanPromise = this.qianfanController.ensureQianfanReady();
      this.replyDispatcher = createWechatToQianfanDispatcher();

      const callbackState = await startWxbotCallbackServer({
        onCallback: async (line, parsed, body) => {
          try {
            if (shouldLogCallback(parsed)) this.log('info', line, { workerName: 'wechat' });
            await this.replyDispatcher.handleCallback(parsed, body);
          } catch (err) {
            this.log('error', `[微信回调] 处理失败：${err.message || err}`, { workerName: 'wechat' });
          }
        },
        silent: !this.cliMode,
        forcePort: true,
      });

      if (callbackState.alreadyRunning) {
        throw new Error('8787 回调端口已被占用，请关闭旧进程后重试');
      }
      this.callbackServer = callbackState.server;

      startWxbotExe();
      this.log('info', '[微信] wxbot.exe 已启动，等待扫码登录…');

      const [wechatReport, qianfanResult] = await Promise.all([
        this.waitForWechatInjection(),
        qianfanPromise,
      ]);

      if (wechatReport.wrongLoginWxid) {
        this.lastError = '当前登录微信不是机器人号';
        this.status = 'degraded';
        this.emitStatus();
        return { ok: false, message: this.lastError, wechatReport };
      }

      this.wechatReady = wechatReport.ok === true;
      this.hookConnected = Number(wechatReport.connectedCount || 0) >= 1;

      try {
        await syncWxbotCallbackConfig();
      } catch (err) {
        this.log('warn', `[回调] 同步 wxbot 配置失败：${err.message || err}`);
      }

      if (!qianfanResult.ok) {
        throw new Error(qianfanResult.lastError || '千帆未能自动启动');
      }

      await this.startListener(qianfanResult.attachResult);

      this.status = 'running';
      this.log('info', '[就绪] 中转已启动，可以接收通知并回复买家');
      this.emitStatus();
      return { ok: true, status: this.getStatus() };
    } catch (err) {
      this.lastError = err.message || String(err);
      this.status = 'degraded';
      this.log('error', `[中转] 启动失败：${this.lastError}`);
      this.emitStatus();
      return { ok: false, message: this.lastError };
    }
  }

  async stop(reason = 'manual') {
    this.status = 'stopped';
    this.wechatReady = false;
    this.qianfanReady = false;
    this.listenerReady = false;
    this.hookConnected = false;

    try {
      const handle = getListenerHandle();
      if (handle?.stop) {
        await handle.stop();
      }
    } catch (err) {
      this.log('warn', `[千帆] 停止监听失败：${err.message || err}`);
    }
    clearListenerHandle();

    if (this.callbackServer) {
      await new Promise((resolve) => {
        try {
          this.callbackServer.close(() => resolve());
        } catch {
          resolve();
        }
      });
      this.callbackServer = null;
    }

    this.log('info', `[中转] 已停止（${reason}）`);
    this.emitStatus();
    return this.getStatus();
  }

  setNotifyAccountCount(count) {
    this.notifyAccountCount = Number(count) || 0;
    this.emitStatus();
  }

  dispose() {
    this.removeAllListeners();
  }
}

module.exports = {
  RelayService,
};
