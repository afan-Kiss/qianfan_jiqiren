const crypto = require('crypto');
const path = require('path');

const DEFAULT_REQUEST_TIMEOUT_MS = Number(process.env.QIANFAN_SIM_REQUEST_TIMEOUT_MS || 10000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.QIANFAN_SIM_HEARTBEAT_INTERVAL_MS || 3000);

function getRequestTimeoutMs() {
  let timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  if (process.env.QIANFAN_SIM_MODE === '1') {
    try {
      const { readState } = require(path.join(process.cwd(), 'scripts/sim/sim-chaos-state'));
      const chaosTimeout = Number(readState().requestTimeoutMs || 0);
      if (chaosTimeout > 0) timeoutMs = chaosTimeout;
    } catch {
      // ignore
    }
  }
  return timeoutMs;
}

if (process.env.QIANFAN_SIM_MODE === '1') {
  try {
    require(path.join(process.cwd(), 'scripts/sim/install-fake-deps')).installFakeDeps();
  } catch {
    delete process.env.QIANFAN_SIM_MODE;
  }
}

function createWorkerRuntime(options = {}) {
  const workerName = options.workerName || process.env.QIANFAN_WORKER_NAME || 'unknown';
  const subscriptions = new Map();
  const timers = [];
  const cleanups = [];
  const pendingRequests = new Map();
  let simInjectHandler = null;
  let wechatRecoverHandler = null;
  let heartbeatTimer = null;
  let shuttingDown = false;

  process.env.QIANFAN_DISTRIBUTED_RUNTIME = '1';

  function newTraceId() {
    return crypto.randomBytes(8).toString('hex');
  }

  function newRequestId() {
    return crypto.randomBytes(8).toString('hex');
  }

  function sendToSupervisor(message) {
    if (typeof process.send !== 'function') return false;
    try {
      process.send(message);
      return true;
    } catch {
      return false;
    }
  }

  function log(level, message, extra = {}) {
    sendToSupervisor({
      type: 'worker.log',
      workerName,
      level,
      message,
      traceId: extra.traceId || '',
      topic: extra.topic || '',
    });
  }

  function reportError(options = {}) {
    const message = String(options.message || options.error?.message || '模块运行异常').trim();
    if (!message) return;
    sendToSupervisor({
      type: 'worker.error',
      workerName,
      fatal: options.fatal === true,
      recover: options.recover || '',
      errorCode: options.errorCode || options.error?.code || '',
      reason: options.reason || options.error?.reason || '',
      waitingRecovery: options.waitingRecovery === true,
      silent: options.silent === true,
      error: {
        message,
        code: options.errorCode || options.error?.code || '',
        reason: options.reason || '',
        stack: options.stack || options.error?.stack || '',
      },
    });
  }

  function reportWechatSendError(err, extra = {}) {
    if (!err) return;
    if (err.waitingRecovery) {
      reportError({
        message: err.message || '微信运行时恢复中，暂停发送',
        errorCode: err.code || 'WECHAT_RUNTIME_RECOVERING',
        reason: extra.reason || 'waiting_wechat_runtime_recovery',
        waitingRecovery: true,
        silent: true,
      });
      return;
    }
    if (err.shouldRecover) {
      reportError({
        message: err.message || '微信发送连续失败，触发运行时恢复',
        errorCode: err.code || err.errorCode || 'WXBOT_SEND_ESCALATED',
        reason: err.recoverReason || extra.reason || 'send_failures_threshold',
        recover: 'wechat-runtime',
      });
      return;
    }
    if (err.runtimeFault) {
      reportError({
        message: err.message || '微信发送失败',
        errorCode: err.code || err.errorCode || 'WXBOT_RUNTIME_FAULT',
        reason: extra.reason || 'wechat_send_runtime_fault',
        silent: extra.silent === true,
      });
      return;
    }
    reportError({
      message: err.message || String(err),
      errorCode: err.code || extra.errorCode || 'WECHAT_SEND_FAILED',
      reason: extra.reason || '',
      fatal: extra.fatal === true,
    });
  }

  function userLog(message, extra = {}) {
    const text = String(message || '').trim();
    if (!text) return;
    sendToSupervisor({
      type: 'worker.userLog',
      workerName,
      message: text,
      level: extra.level || 'info',
      dedupKey: extra.dedupKey || `${workerName}:${text}`,
      time: Date.now(),
    });
  }

  function publish(topic, payload, meta = {}) {
    const traceId = meta.traceId || newTraceId();
    sendToSupervisor({
      type: 'bus.publish',
      topic,
      payload,
      meta: {
        traceId,
        from: workerName,
        time: Date.now(),
        ...meta,
      },
    });
  }

  function buildPersistPayload(action, data, options = {}) {
    const traceId = options.traceId || newTraceId();
    return {
      action,
      data,
      idempotencyKey: options.idempotencyKey || `${action}:${traceId}`,
      traceId,
      sourceWorker: workerName,
      createdAt: Date.now(),
    };
  }

  function request(topic, payload, options = {}) {
    const timeoutMs = options.timeoutMs || getRequestTimeoutMs();
    const traceId = options.traceId || payload.traceId || newTraceId();
    const requestId = newRequestId();

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        log('error', `request timeout topic=${topic} requestId=${requestId}`, {
          traceId,
          topic,
        });
        resolve({
          ok: false,
          error: { message: 'request timeout', code: 'REQUEST_TIMEOUT' },
          traceId,
          requestId,
        });
      }, timeoutMs);

      pendingRequests.set(requestId, (resultPayload) => {
        clearTimeout(timer);
        resolve(resultPayload);
      });

      sendToSupervisor({
        type: 'bus.publish',
        topic,
        payload: {
          ...payload,
          traceId: payload.traceId || traceId,
          sourceWorker: payload.sourceWorker || workerName,
          createdAt: payload.createdAt || Date.now(),
        },
        meta: {
          traceId,
          requestId,
          replyTo: workerName,
          from: workerName,
          time: Date.now(),
        },
      });
    });
  }

  async function persist(action, data, options = {}) {
    const payload = buildPersistPayload(action, data, options);
    const result = await request('task.persist.request', payload, {
      timeoutMs: options.timeoutMs,
      traceId: options.traceId || payload.traceId,
    });
    if (!result.ok) {
      log('error', `persist failed action=${action}: ${result.error?.message || 'unknown'}`, {
        traceId: payload.traceId,
        topic: 'task.persist.request',
      });
    }
    return result;
  }

  function subscribe(topic, handler) {
    if (!subscriptions.has(topic)) subscriptions.set(topic, new Set());
    subscriptions.get(topic).add(handler);
    sendToSupervisor({ type: 'worker.subscribe', workerName, topics: [...subscriptions.keys()] });
    return () => {
      subscriptions.get(topic)?.delete(handler);
      sendToSupervisor({ type: 'worker.subscribe', workerName, topics: [...subscriptions.keys()] });
    };
  }

  function onTopic(topic, handler) {
    return subscribe(topic, handler);
  }

  function onSimInject(handler) {
    simInjectHandler = handler;
  }

  function onWechatRecover(handler) {
    wechatRecoverHandler = handler;
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function resolvePendingRequest(message) {
    const requestId = message.meta?.requestId;
    if (!requestId) return false;
    const cb = pendingRequests.get(requestId);
    if (!cb) return false;
    pendingRequests.delete(requestId);
    cb(message.payload || {});
    return true;
  }

  function dispatchBusMessage(message) {
    if (message.topic === 'task.persist.result' && resolvePendingRequest(message)) {
      return;
    }

    const handlers = subscriptions.get(message.topic);
    if (!handlers) return;
    for (const handler of handlers) {
      Promise.resolve(handler(message.payload, message.meta || {})).catch((err) => {
        sendToSupervisor({
          type: 'worker.error',
          workerName,
          error: { message: err.message || String(err), stack: err.stack || '' },
        });
      });
    }
  }

  function registerCleanup(fn) {
    if (typeof fn === 'function') cleanups.push(fn);
  }

  function registerTimer(timer) {
    timers.push(timer);
    return timer;
  }

  async function shutdown(reason = 'manual') {
    if (shuttingDown) return;
    shuttingDown = true;
    process.env.QIANFAN_RUNTIME_SHUTTING_DOWN = '1';
    stopHeartbeat();
    for (const timer of timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    timers.length = 0;
    for (const [, cb] of pendingRequests.entries()) {
      cb({ ok: false, error: { message: 'worker shutdown', code: 'WORKER_SHUTDOWN' } });
    }
    pendingRequests.clear();
    for (const fn of cleanups.reverse()) {
      try {
        await Promise.resolve(fn(reason));
      } catch {
        // ignore cleanup errors
      }
    }
    if (typeof process.disconnect === 'function' && process.connected) {
      try {
        process.disconnect();
      } catch {
        // ignore
      }
    }
    process.exit(0);
  }

  process.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'shutdown') {
      void shutdown(message.reason || 'shutdown');
      return;
    }
    if (message.type === 'sim.inject') {
      if (simInjectHandler) {
        try {
          simInjectHandler(message);
        } catch (err) {
          sendToSupervisor({
            type: 'worker.error',
            workerName,
            error: { message: err.message || String(err), stack: err.stack || '' },
          });
        }
      }
      return;
    }
    if (message.type === 'sim.stopHeartbeat') {
      stopHeartbeat();
      return;
    }
    if (message.type === 'wechat.recover') {
      if (wechatRecoverHandler) {
        Promise.resolve(wechatRecoverHandler(message)).catch((err) => {
          sendToSupervisor({
            type: 'worker.error',
            workerName,
            error: { message: err.message || String(err), stack: err.stack || '' },
          });
        });
      }
      return;
    }
    if (message.type === 'bus.message') {
      dispatchBusMessage(message);
    }
  });

  process.on('uncaughtException', (err) => {
    sendToSupervisor({
      type: 'worker.error',
      workerName,
      error: { message: err.message || String(err), stack: err.stack || '' },
    });
    void shutdown('uncaughtException').finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    sendToSupervisor({
      type: 'worker.error',
      workerName,
      error: {
        message: reason?.message || String(reason),
        stack: reason?.stack || '',
      },
    });
  });

  function reportStatus(patch = {}) {
    sendToSupervisor({
      type: 'worker.status',
      workerName,
      time: Date.now(),
      ...patch,
    });
  }

  sendToSupervisor({ type: 'worker.ready', workerName });
  sendToSupervisor({ type: 'worker.subscribe', workerName, topics: [...subscriptions.keys()] });

  heartbeatTimer = setInterval(() => {
    sendToSupervisor({ type: 'worker.heartbeat', workerName, time: Date.now() });
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  if (process.env.QIANFAN_SIM_CRASH_ON_READY === '1') {
    const crashTimer = setTimeout(() => process.exit(1), Number(process.env.QIANFAN_SIM_CRASH_DELAY_MS || 200));
    if (typeof crashTimer.unref === 'function') crashTimer.unref();
  }

  if (process.env.QIANFAN_SIM_STOP_HEARTBEAT === '1') {
    stopHeartbeat();
  }

  return {
    workerName,
    log,
    userLog,
    publish,
    request,
    persist,
    buildPersistPayload,
    subscribe,
    onTopic,
    onSimInject,
    onWechatRecover,
    stopHeartbeat,
    registerCleanup,
    registerTimer,
    reportStatus,
    reportError,
    reportWechatSendError,
    shutdown,
    newTraceId,
  };
}

module.exports = {
  createWorkerRuntime,
  DEFAULT_REQUEST_TIMEOUT_MS,
};
