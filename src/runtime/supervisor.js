const path = require('path');
const { EventEmitter } = require('events');
const { WorkerRunner } = require('./worker-runner');
const { Watchdog } = require('./watchdog');
const { RestartPolicy } = require('./restart-policy');
const { MessageBus } = require('./message-bus');
const { RuntimeState } = require('./runtime-state');
const { createRuntimeLogger } = require('./runtime-logger');
const { START_ORDER, STOP_ORDER, QIANFAN_BOOT_ORDER, WECHAT_BOOT_ORDER, getWorkerEntries, TOPIC_ROUTES } = require('./worker-registry');
const { WORKER_LABELS } = require('../shared/activity-log');
const dataStore = require('../qianfan-data-store');
const {
  formatRestartReason,
  buildUserHeartbeatSummary,
  buildWorkerModulesSummary,
} = require('../shared/user-activity-log');
const {
  computeRuntimeHealth,
  buildHealthTransitionLogs,
} = require('../shared/runtime-health');

// 正常喂狗摘要：最多每 4 小时向「最近动态」写一条（异常/恢复仍即时记录）
const HEARTBEAT_SUMMARY_MS = 4 * 60 * 60 * 1000;
const STATUS_PUSH_THROTTLE_MS = 1000;

class RuntimeSupervisor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.rootDir = options.rootDir || process.cwd();
    this.runtimeRoot = options.runtimeRoot || this.rootDir;
    this.logsDir = options.logsDir || path.join(this.rootDir, 'logs');
    this.logger = createRuntimeLogger({ logsDir: this.logsDir });
    this.state = new RuntimeState();
    this.messageBus = new MessageBus();
    this.watchdog = new Watchdog(options.watchdog || {});
    this.restartPolicy = new RestartPolicy(options.restartPolicy || {});
    this.runners = new Map();
    this.workerEntries = getWorkerEntries(this.runtimeRoot);
    this.disposed = false;
    this.pendingRestartTimers = new Map();
    this.simEnv = options.simEnv || {};
    this.workerExtraEnv = options.workerExtraEnv || {};
    this.pendingCrashWorkers = new Set();
    this.restartingWorkers = new Set();
    this.startWorkerDelayMs = options.startWorkerDelayMs ?? 300;
    this.qianfanBootTimeoutMs = options.qianfanBootTimeoutMs ?? 180000;
    this.startAllPromise = null;
    this.startAllInProgress = false;
    this.wechatBootCompleted = false;
    this.wechatBootInProgress = false;
    this.workerStatusSnapshot = new Map();
    this.healthStatusSnapshot = null;
    this.notifyAccountCount = 0;
    this.heartbeatSummaryTimer = null;
    this.lastWatchdogFeedAt = 0;
    this.lastStatusEmitAt = 0;

    this.watchdog.on('timeout', (payload) => this.handleWatchdogTimeout(payload));
    this.messageBus.on('published', (message) => this.forwardBusMessage(message));
  }

  fileLog(level, message, extra = {}) {
    const entry = this.logger.write({
      level,
      workerName: extra.workerName || 'supervisor',
      traceId: extra.traceId || '',
      topic: extra.topic || '',
      message,
    });
    this.state.appendLog(entry);
    return entry;
  }

  userLog(message, extra = {}) {
    const text = String(message || '').trim();
    if (!text) return;
    const entry = {
      level: extra.level || 'info',
      workerName: extra.workerName || 'supervisor',
      message: text,
      userFacing: true,
      time: extra.time || Date.now(),
      dedupKey: extra.dedupKey || text,
    };
    this.state.appendLog(entry);
    this.emit('log', entry);
    return entry;
  }

  log(level, message, extra = {}) {
    this.fileLog(level, message, extra);
  }

  clearHeartbeatSummaryTimer() {
    if (this.heartbeatSummaryTimer) {
      clearInterval(this.heartbeatSummaryTimer);
      this.heartbeatSummaryTimer = null;
    }
  }

  startHeartbeatSummaryTimer() {
    this.clearHeartbeatSummaryTimer();
    this.heartbeatSummaryTimer = setInterval(() => {
      if (this.disposed || this.state.supervisorStatus === 'stopped') return;
      if (!['running', 'starting', 'degraded'].includes(this.state.supervisorStatus)) return;
      if (!this.lastWatchdogFeedAt) return;
      const feedDate = new Date(this.lastWatchdogFeedAt);
      const clock = [
        String(feedDate.getHours()).padStart(2, '0'),
        String(feedDate.getMinutes()).padStart(2, '0'),
        String(feedDate.getSeconds()).padStart(2, '0'),
      ].join(':');
      this.userLog(`看门狗正常运行，最近喂狗：${clock}`, {
        dedupKey: `watchdog-routine:${Math.floor(Date.now() / HEARTBEAT_SUMMARY_MS)}`,
      });
    }, HEARTBEAT_SUMMARY_MS);
    if (typeof this.heartbeatSummaryTimer.unref === 'function') {
      this.heartbeatSummaryTimer.unref();
    }
  }

  maybeEmitStatusThrottled() {
    const now = Date.now();
    if (now - this.lastStatusEmitAt < STATUS_PUSH_THROTTLE_MS) return;
    this.lastStatusEmitAt = now;
    this.emitStatus();
  }

  maybeLogHealthTransitions(nextHealth) {
    if (!nextHealth) return;
    const logs = buildHealthTransitionLogs(this.healthStatusSnapshot, nextHealth);
    for (const entry of logs) {
      this.userLog(entry.message, {
        dedupKey: entry.dedupKey,
        level: entry.level || 'info',
      });
    }
    this.healthStatusSnapshot = nextHealth;
  }

  noteWatchdogFeed(workerName) {
    this.lastWatchdogFeedAt = Date.now();
    if (workerName) {
      this.watchdog.beat(workerName);
    }
  }

  maybeLogWorkerStatusChange(workerName, patch = {}) {
    const prev = this.workerStatusSnapshot.get(workerName) || {};
    const next = {
      status: patch.status || prev.status || '',
      phase: patch.phase || prev.phase || '',
      qianfanReady: patch.qianfanReady ?? prev.qianfanReady,
      listenerReady: patch.listenerReady ?? prev.listenerReady,
      lastError: patch.lastError || patch.reason || prev.lastError || '',
      shopReport: patch.shopReport || prev.shopReport || null,
    };
    const changed = next.status !== prev.status
      || next.phase !== prev.phase
      || next.qianfanReady !== prev.qianfanReady
      || next.listenerReady !== prev.listenerReady;
    this.workerStatusSnapshot.set(workerName, next);
    if (!changed) return;

    const label = WORKER_LABELS[workerName] || workerName;
    if (workerName === 'qianfan-listener' && next.qianfanReady && next.listenerReady) {
      void this.ensureWechatWorkersStarted();
      const shopReport = patch.shopReport || prev.shopReport;
      const shops = Array.isArray(shopReport?.shops) ? shopReport.shops : [];
      const shopNames = shops
        .map((shop) => String(shop.shopTitle || '').trim())
        .filter(Boolean)
        .join('、');
      const shopText = shopNames ? `，店铺：${shopNames}` : '';
      this.userLog(`「${label}」运行正常${shopText}`, {
        dedupKey: `worker-ready:${workerName}:${shopNames || 'none'}`,
      });
      return;
    }

    if (next.status === 'running' && workerName !== 'qianfan-listener') {
      this.userLog(`「${label}」运行正常`, { dedupKey: `worker-running:${workerName}` });
      return;
    }

    if (next.status === 'degraded' || next.phase === 'degraded' || next.phase === 'failed') {
      if (['checking', 'launching', 'waiting_shops', 'waiting_launch', 'starting', 'qianfan_ready'].includes(next.phase)) {
        return;
      }
      const reason = String(next.lastError || '需要检查').trim();
      const readable = reason && !/[a-z]{5,}/i.test(reason) ? reason : '运行异常，请查看状态卡片';
      this.userLog(`「${label}」异常：${readable}`, {
        dedupKey: `worker-degraded:${workerName}:${readable.slice(0, 40)}`,
        level: 'error',
      });
      return;
    }

    if (next.status === 'failed' || next.status === 'timeout') {
      const reason = String(next.lastError || '等待自动重启').trim();
      const readable = reason && !/[a-z]{5,}/i.test(reason) ? reason : '模块已停止';
      this.userLog(`「${label}」已停止：${readable}`, {
        dedupKey: `worker-failed:${workerName}:${readable.slice(0, 40)}`,
        level: 'error',
      });
    }
  }

  registerDefaultWorkers() {
    for (const workerName of START_ORDER) {
      this.state.ensureWorker(workerName);
    }
    return [...START_ORDER];
  }

  createRunner(workerName) {
    const entry = this.workerEntries[workerName];
    if (!entry) throw new Error(`Unknown worker: ${workerName}`);

    const runner = new WorkerRunner({
      workerName,
      workerEntry: entry,
      rootDir: this.rootDir,
      runtimeRoot: this.runtimeRoot,
      logger: this.logger,
      extraEnv: {
        ...this.simEnv,
        ...(this.workerExtraEnv[workerName] || {}),
      },
    });

    runner.on('message', (message) => this.handleWorkerMessage(workerName, message));
    runner.on('exit', ({ crashed }) => {
      if (!crashed) return;
      const label = WORKER_LABELS[workerName] || workerName;
      this.userLog(`worker 已退出或异常停止：${label}`, {
        dedupKey: `worker-exit:${workerName}`,
        level: 'error',
      });
      this.scheduleWorkerRestart(workerName, 'crashed');
    });
    runner.on('stdout', (text) => this.fileLog('info', text, { workerName }));
    runner.on('stderr', (text) => this.fileLog('error', text, { workerName }));

    this.runners.set(workerName, runner);
    return runner;
  }

  getRunner(workerName) {
    if (!this.runners.has(workerName)) {
      this.createRunner(workerName);
    }
    return this.runners.get(workerName);
  }

  async startWorker(workerName) {
    const existing = this.state.ensureWorker(workerName);
    const runner = this.runners.get(workerName);
    if (
      runner
      && runner.running
      && ['running', 'starting', 'degraded'].includes(existing.status)
    ) {
      return { ok: true, workerName, alreadyRunning: true, pid: runner.pid, status: existing.status };
    }

    const policy = this.restartPolicy.getState(workerName);
    if (policy.failed) {
      this.state.setWorkerStatus(workerName, { status: 'failed', lastError: '重启次数过多，需手动重启' });
      this.emitStatus();
      return { ok: false, workerName, status: 'failed', message: '重启次数过多，需手动重启' };
    }

    const activeRunner = this.getRunner(workerName);
    const oneShotEnv = this.pendingCrashWorkers.has(workerName)
      ? { QIANFAN_SIM_CRASH_ON_READY: '1' }
      : {};
    if (oneShotEnv.QIANFAN_SIM_CRASH_ON_READY) {
      this.pendingCrashWorkers.delete(workerName);
    }

    this.state.setWorkerStatus(workerName, { status: 'starting', startTime: Date.now(), lastError: '' });
    this.emitStatus();

    const result = await activeRunner.start(oneShotEnv);
    if (!result.ok) {
      this.state.setWorkerStatus(workerName, {
        status: 'failed',
        pid: null,
        lastError: activeRunner.lastError || result.error?.message || 'worker fork failed',
      });
      this.emitStatus();
      const label = WORKER_LABELS[workerName] || workerName;
      this.userLog(`「${label}」启动失败，将自动重试`, {
        dedupKey: `worker-start-failed:${workerName}`,
        level: 'error',
      });
      this.restartPolicy.recordRestart(workerName);
      this.scheduleWorkerRestart(workerName, 'start_failed');
      return {
        ok: false,
        workerName,
        status: 'failed',
        message: activeRunner.lastError || result.error?.message || 'worker fork failed',
      };
    }

    this.watchdog.register(workerName);
    this.state.setWorkerStatus(workerName, { status: 'starting', pid: result.pid || null });
    this.emitStatus();
    return { ok: true, workerName, pid: result.pid || null };
  }

  async stopWorker(workerName, reason = 'manual') {
    const runner = this.runners.get(workerName);
    if (!runner) {
      this.state.setWorkerStatus(workerName, { status: 'stopped', pid: null });
      this.watchdog.unregister(workerName);
      this.emitStatus();
      return { ok: true, workerName, stopped: true };
    }

    this.state.setWorkerStatus(workerName, { status: 'stopping' });
    this.emitStatus();
    await runner.stop(reason);
    this.watchdog.unregister(workerName);
    this.state.setWorkerStatus(workerName, { status: 'stopped', pid: null });
    this.emitStatus();
    return { ok: true, workerName, stopped: true };
  }

  async restartWorker(workerName, reason = 'manual', options = {}) {
    if (this.disposed) {
      return { ok: false, workerName, status: 'stopped', message: 'supervisor disposed' };
    }
    if (this.restartingWorkers.has(workerName)) {
      return { ok: false, workerName, status: 'restarting', message: 'worker restart already in progress' };
    }
    this.restartingWorkers.add(workerName);

    try {
      if (options.manual) {
        this.restartPolicy.reset(workerName);
      }

      const policy = this.restartPolicy.getState(workerName);
      if (!policy.canRestart && !options.manual) {
        this.state.setWorkerStatus(workerName, { status: 'failed', lastError: '重启熔断' });
        this.emitStatus();
        const label = WORKER_LABELS[workerName] || workerName;
        this.userLog(`「${label}」重启次数过多，请手动重启`, {
          dedupKey: `restart-fuse:${workerName}`,
          level: 'error',
        });
        return { ok: false, workerName, status: 'failed', message: '重启熔断' };
      }

      const label = WORKER_LABELS[workerName] || workerName;
      const reasonText = formatRestartReason(reason);
      if (!options.manual && reason !== 'start_failed') {
        this.restartPolicy.recordRestart(workerName);
        this.userLog(`正在重启「${label}」模块（${reasonText}）`, {
          dedupKey: `restart-begin:${workerName}:${reason}:${Date.now()}`,
        });
      } else if (!options.manual && reason === 'start_failed') {
        this.userLog(`正在重启「${label}」模块（${reasonText}）`, {
          dedupKey: `restart-begin:${workerName}:${reason}:${Date.now()}`,
        });
      }

      this.state.setWorkerStatus(workerName, {
        status: 'restarting',
        restartCount: policy.restartCount,
      });
      this.emitStatus();

      await this.stopWorker(workerName, reason);
      if (!options.skipDelay && !options.manual) {
        const delayMs = this.restartPolicy.getDelayMs(workerName);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      const startResult = await this.startWorker(workerName);
      if (!options.manual && startResult.ok) {
        this.userLog(`「${label}」已重启完成，运行正常`, {
          dedupKey: `restart-ok:${workerName}:${Date.now()}`,
        });
      } else if (!startResult.ok) {
        this.userLog(`「${label}」重启失败：${startResult.message || '请稍后重试'}`, {
          dedupKey: `restart-fail:${workerName}:${startResult.message || 'unknown'}`,
          level: 'error',
        });
      }
      return startResult;
    } finally {
      this.restartingWorkers.delete(workerName);
    }
  }

  cancelAllPendingRestarts() {
    for (const timer of this.pendingRestartTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingRestartTimers.clear();
  }

  scheduleWorkerRestart(workerName, reason) {
    if (this.disposed || this.pendingRestartTimers.has(workerName) || this.restartingWorkers.has(workerName)) {
      return;
    }
    const delayMs = this.restartPolicy.getDelayMs(workerName);
    const timer = setTimeout(async () => {
      this.pendingRestartTimers.delete(workerName);
      if (this.disposed) return;
      try {
        await this.restartWorker(workerName, reason, { skipDelay: true });
      } catch (err) {
        this.log('error', `重启 ${workerName} 失败：${err.message}`, { workerName });
      }
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.pendingRestartTimers.set(workerName, timer);
  }

  handleWatchdogTimeout({ workerName, lastBeatAt, timeoutMs }) {
    const label = WORKER_LABELS[workerName] || workerName;
    this.userLog(`看门狗检测到「${label}」心跳超时，正在重启`, {
      workerName,
      dedupKey: `watchdog-timeout:${workerName}:${Math.floor(Date.now() / 10000)}`,
      level: 'error',
    });
    this.state.setWorkerStatus(workerName, {
      status: 'timeout',
      lastError: `心跳超时，lastBeatAt=${lastBeatAt}`,
    });
    this.emitStatus();
    this.scheduleWorkerRestart(workerName, 'timeout');
  }

  handleWorkerMessage(workerName, message = {}) {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'worker.ready') {
      const initialStatus = workerName === 'qianfan-listener' ? 'starting' : 'running';
      this.state.setWorkerStatus(workerName, {
        status: initialStatus,
        pid: this.getRunner(workerName).pid,
        workerAlive: true,
      });
      this.noteWatchdogFeed(workerName);
      if (workerName !== 'qianfan-listener') {
        const label = WORKER_LABELS[workerName] || workerName;
        this.userLog(`「${label}」模块已就绪`, { dedupKey: `worker-ready:${workerName}` });
      }
      this.emitStatus();
      return;
    }

    if (message.type === 'worker.status') {
      const patch = {
        workerAlive: message.workerAlive !== false,
        businessReady: message.businessReady === true,
        qianfanReady: message.qianfanReady === true,
        listenerReady: message.listenerReady === true,
        phase: message.phase || '',
        qianfanRuntime: message.qianfanRuntime || null,
        shopReport: message.shopReport || null,
        reason: message.reason || '',
        lastError: message.lastError || message.reason || '',
        lastStatusAt: message.time || Date.now(),
      };
      if (workerName === 'qianfan-listener') {
    const transitional = ['checking', 'launching', 'waiting_shops', 'waiting_launch', 'starting', 'qianfan_ready'].includes(message.phase);
        if (message.phase === 'running' && message.qianfanReady && message.listenerReady) {
          patch.status = 'running';
        } else if (message.phase === 'failed') {
          patch.status = 'failed';
        } else if (transitional) {
          patch.status = 'starting';
        } else if (message.phase === 'degraded' || !message.qianfanReady || !message.listenerReady) {
          patch.status = 'degraded';
        } else {
          patch.status = 'starting';
        }
      } else if (message.phase === 'running' || message.businessReady === true) {
        patch.status = 'running';
      } else if (message.phase === 'failed') {
        patch.status = 'failed';
      } else if (message.phase === 'degraded') {
        patch.status = 'degraded';
      } else {
        patch.status = 'starting';
      }
      this.state.setWorkerStatus(workerName, patch);
      this.noteWatchdogFeed(workerName);
      this.maybeLogWorkerStatusChange(workerName, patch);
      this.emitStatus();
      return;
    }

    if (message.type === 'worker.heartbeat') {
      this.noteWatchdogFeed(workerName);
      const current = this.state.ensureWorker(workerName);
      const patch = { lastHeartbeatAt: message.time || Date.now() };
      const lockedStatuses = ['failed', 'degraded', 'timeout', 'restarting', 'stopping'];
      if (!lockedStatuses.includes(current.status)) {
        if (workerName === 'qianfan-listener') {
          const qianfanReady = current.qianfanReady === true && current.listenerReady === true;
          if (qianfanReady) {
            patch.status = 'running';
          } else if (current.status === 'starting' || current.status === 'degraded') {
            patch.status = current.status;
          } else {
            patch.status = 'degraded';
          }
        } else {
          patch.status = 'running';
        }
      }
      this.state.setWorkerStatus(workerName, patch);
      this.emit('heartbeat', { workerName, time: message.time || Date.now() });
      this.maybeEmitStatusThrottled();
      return;
    }

    if (message.type === 'worker.error') {
      const errMsg = message.error?.message || '模块运行异常';
      this.state.setWorkerStatus(workerName, { status: 'degraded', lastError: errMsg });
      const label = WORKER_LABELS[workerName] || workerName;
      const readable = /[a-z]{5,}/i.test(errMsg) ? '模块运行异常，请查看状态卡片' : errMsg;
      this.userLog(`「${label}」异常：${readable}`, {
        dedupKey: `worker-error:${workerName}:${readable.slice(0, 40)}`,
        level: 'error',
      });
      this.fileLog('error', errMsg, { workerName });
      this.emitStatus();
      return;
    }

    if (message.type === 'worker.userLog') {
      const text = String(message.message || '').trim();
      if (!text) return;
      this.userLog(text, {
        workerName,
        dedupKey: message.dedupKey || `${workerName}:${text}`,
        level: message.level || 'info',
        time: message.time || Date.now(),
      });
      return;
    }

    if (message.type === 'worker.log') {
      this.fileLog(message.level || 'info', message.message || '', {
        workerName,
        traceId: message.traceId || '',
        topic: message.topic || '',
      });
      return;
    }

    const routed = this.messageBus.routeFromWorker(workerName, message);
    if (routed?.type === 'bus.published') {
      // 内部总线路由不写活动日志，避免刷屏
    }
  }

  forwardBusMessage(message) {
    const replyTo = message.meta?.replyTo;
    if (message.topic === 'task.persist.result' && replyTo) {
      const replyRunner = this.runners.get(replyTo);
      if (replyRunner) {
        const sent = replyRunner.send({
          type: 'bus.message',
          topic: message.topic,
          payload: message.payload,
          meta: message.meta,
        });
        if (sent) return;
      }
      this.log('error', `消息转发失败：${message.topic} → ${replyTo}（缺少 replyTo）`, {
        workerName: replyTo,
        topic: message.topic,
        traceId: message.meta?.traceId || '',
      });
    }

    const targets = this.messageBus.getTargetsForTopic(message.topic);
    for (const workerName of targets) {
      if (message.topic === 'task.persist.result' && replyTo && workerName === replyTo) {
        continue;
      }
      const runner = this.runners.get(workerName);
      if (!runner) continue;
      const sent = runner.send({
        type: 'bus.message',
        topic: message.topic,
        payload: message.payload,
        meta: message.meta,
      });
      if (!sent) {
        this.log('error', `消息转发失败：${message.topic} → ${workerName}`, {
          workerName,
          topic: message.topic,
          traceId: message.meta?.traceId || '',
        });
      }
    }
  }

  async startAll() {
    if (this.startAllPromise) return this.startAllPromise;

    const current = this.state.supervisorStatus;
    if (current === 'running' || current === 'starting') {
      return this.getStatus();
    }

    this.startAllInProgress = true;
    this.startAllPromise = this._startAllInner();
    try {
      return await this.startAllPromise;
    } finally {
      this.startAllPromise = null;
      this.startAllInProgress = false;
    }
  }

  async startWechatWorkers() {
    if (this.wechatBootCompleted) {
      return { ok: true, alreadyStarted: true };
    }

    this.userLog('千帆已就绪，正在启动微信…', { dedupKey: 'supervisor-start-wechat' });

    for (const workerName of WECHAT_BOOT_ORDER) {
      await this.startWorker(workerName);
      await new Promise((resolve) => setTimeout(resolve, this.startWorkerDelayMs));
    }

    this.wechatBootCompleted = true;
    return { ok: true };
  }

  async ensureWechatWorkersStarted() {
    if (this.disposed || this.wechatBootCompleted || this.wechatBootInProgress) return;
    const listener = this.getWorkerStatus('qianfan-listener');
    if (!(listener.qianfanReady && listener.listenerReady)) return;

    this.wechatBootInProgress = true;
    try {
      await this.startWechatWorkers();
      const workers = START_ORDER.map((name) => this.getWorkerStatus(name));
      const anyFailed = workers.some((w) => w.status === 'failed' || w.status === 'timeout');
      if (!anyFailed && ['degraded', 'starting'].includes(this.state.supervisorStatus)) {
        this.state.setSupervisorStatus('running');
        const summary = buildWorkerModulesSummary(this.getStatus());
        this.userLog(`各模块已启动：${summary}`, {
          dedupKey: 'supervisor-started:deferred',
        });
        this.startHeartbeatSummaryTimer();
      }
      this.emitStatus();
    } finally {
      this.wechatBootInProgress = false;
    }
  }

  async waitForQianfanListenerReady(timeoutMs = this.qianfanBootTimeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const listener = this.getWorkerStatus('qianfan-listener');
      if (listener.qianfanReady === true && listener.listenerReady === true) {
        return { ok: true, listener };
      }
      if (listener.status === 'failed') {
        return { ok: false, listener, reason: listener.lastError || '千帆监听启动失败' };
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const listener = this.getWorkerStatus('qianfan-listener');
    return {
      ok: false,
      listener,
      reason: listener.lastError || listener.reason || '千帆监听等待超时',
    };
  }

  async _startAllInner() {
    this.registerDefaultWorkers();
    this.state.setSupervisorStatus('starting');
    this.watchdog.start();
    this.userLog('中转服务正在启动', { dedupKey: 'supervisor-starting' });

    for (const workerName of QIANFAN_BOOT_ORDER) {
      await this.startWorker(workerName);
      await new Promise((resolve) => setTimeout(resolve, this.startWorkerDelayMs));
    }

    this.userLog('千帆已启动，正在等待店铺工作台就绪…', {
      dedupKey: 'supervisor-wait-qianfan',
    });
    const qianfanWait = await this.waitForQianfanListenerReady();
    if (!qianfanWait.ok) {
      this.userLog(`千帆尚未就绪：${qianfanWait.reason || '请检查千帆登录状态'}`, {
        dedupKey: 'supervisor-qianfan-not-ready',
        level: 'warn',
      });
      this.state.setSupervisorStatus('degraded');
      this.startHeartbeatSummaryTimer();
      this.emitStatus();
      void this.ensureWechatWorkersStarted();
      return this.getStatus();
    }

    await this.startWechatWorkers();

    const workers = START_ORDER.map((name) => this.getWorkerStatus(name));
    const anyFailed = workers.some((w) => w.status === 'failed' || w.status === 'timeout');
    this.state.setSupervisorStatus(anyFailed ? 'degraded' : 'running');
    const summary = buildWorkerModulesSummary(this.getStatus());
    this.userLog(anyFailed ? `各模块已启动，部分模块异常：${summary}` : `各模块已启动：${summary}`, {
      dedupKey: `supervisor-started:${anyFailed ? 'degraded' : 'ok'}`,
    });
    this.startHeartbeatSummaryTimer();
    this.emitStatus();
    return this.getStatus();
  }

  async stopAll(reason = 'manual') {
    this.cancelAllPendingRestarts();
    this.clearHeartbeatSummaryTimer();
    this.wechatBootCompleted = false;
    this.wechatBootInProgress = false;
    this.healthStatusSnapshot = null;
    this.state.setSupervisorStatus('stopping');
    this.emitStatus();

    for (const workerName of STOP_ORDER) {
      await this.stopWorker(workerName, reason);
    }

    this.watchdog.stop();
    this.state.setSupervisorStatus('stopped');
    this.userLog('中转服务已停止', { dedupKey: 'supervisor-stopped' });
    this.emitStatus();
    return this.getStatus();
  }

  getWorkerStatus(workerName) {
    const runner = this.runners.get(workerName);
    const stateWorker = this.state.ensureWorker(workerName);
    const runnerStatus = runner ? runner.getStatus() : {};
    return {
      ...runnerStatus,
      ...stateWorker,
      workerName,
      status: stateWorker.status || runnerStatus.status,
      restartPolicy: this.restartPolicy.getState(workerName),
    };
  }

  getStatus() {
    const workers = START_ORDER.map((name) => this.getWorkerStatus(name));
    const listener = workers.find((w) => w.workerName === 'qianfan-listener') || {};
    const callback = workers.find((w) => w.workerName === 'wechat-callback') || {};
    const anyFailed = workers.some((w) => w.status === 'failed' || w.status === 'crashed' || w.status === 'timeout');
    const anyRunning = workers.some((w) => w.status === 'running');
    const anyStarting = workers.some((w) => w.status === 'starting' || w.status === 'restarting');
    const qianfanReady = listener.qianfanReady === true && listener.listenerReady === true;
    const wechatReady = callback.status === 'running' || callback.businessReady === true;
    const listenerReadyFlag = listener.listenerReady === true;

    let supervisorStatus = this.state.supervisorStatus;
    if (supervisorStatus === 'running' && anyFailed) supervisorStatus = 'degraded';
    if (anyStarting && supervisorStatus !== 'stopping') supervisorStatus = 'starting';
    if (!anyRunning && supervisorStatus === 'running') supervisorStatus = 'degraded';
    if (
      supervisorStatus === 'running'
      && listener.workerAlive
      && !qianfanReady
    ) {
      supervisorStatus = 'degraded';
    }

    return {
      supervisorStatus,
      workers,
      qianfanRuntime: listener.qianfanRuntime || null,
      qianfanReady,
      listenerReady: listener.listenerReady === true,
      wechatReady,
      relayRunning: ['starting', 'running', 'degraded'].includes(supervisorStatus),
      workerAlive: workers.some((worker) => worker.workerAlive !== false && worker.status !== 'stopped'),
      lastWorkerHeartbeatAt: workers.reduce((max, worker) => {
        const ts = Number(worker.lastHeartbeatAt || 0);
        return ts > max ? ts : max;
      }, 0) || null,
      lastWatchdogFeedAt: this.lastWatchdogFeedAt || null,
      lastStatusAt: Date.now(),
      todayStats: dataStore.getTodayStats(),
      recentLogs: this.state.getSnapshot().recentLogs.slice(-200),
      topicRoutes: TOPIC_ROUTES,
      health: computeRuntimeHealth({
        supervisorStatus,
        workers,
      qianfanReady,
      listenerReady: listenerReadyFlag,
      wechatReady,
      lastWatchdogFeedAt: this.lastWatchdogFeedAt || null,
      }, {
        notifyAccountCount: this.notifyAccountCount || 0,
      }),
    };
  }

  setNotifyAccountCount(count = 0) {
    this.notifyAccountCount = Math.max(0, Number(count) || 0);
    return this;
  }

  emitStatus() {
    const status = this.getStatus();
    this.maybeLogHealthTransitions(status.health);
    this.emit('status', status);
    return status;
  }

  simInject(workerName, event, payload = {}, meta = {}) {
    const runner = this.runners.get(workerName);
    if (!runner) return false;
    return runner.send({ type: 'sim.inject', event, payload, meta });
  }

  sendSimCommand(workerName, command, payload = {}) {
    const runner = this.runners.get(workerName);
    if (!runner) return false;
    return runner.send({ type: `sim.${command}`, payload });
  }

  markCrashNextStart(workerName) {
    this.pendingCrashWorkers.add(workerName);
    return this;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAllPendingRestarts();
    this.clearHeartbeatSummaryTimer();
    void this.stopAll('dispose').catch(() => {});
    this.watchdog.stop();
    if (typeof this.watchdog.dispose === 'function') {
      this.watchdog.dispose();
    }
    for (const runner of this.runners.values()) {
      if (typeof runner.removeAllListeners === 'function') {
        runner.removeAllListeners();
      }
    }
    this.messageBus.removeAllListeners();
    this.removeAllListeners();
  }
}

module.exports = {
  RuntimeSupervisor,
};
