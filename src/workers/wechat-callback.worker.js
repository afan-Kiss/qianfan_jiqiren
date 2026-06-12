const { createWorkerRuntime } = require('./worker-bootstrap');
const {
  prepareWechatRuntime,
  startCallbackServer,
  stopCallbackServer,
} = require('../adapters/legacy-wechat-callback-adapter');

const runtime = createWorkerRuntime({ workerName: 'wechat-callback' });
const RETRY_MS = Number(process.env.WECHAT_CALLBACK_RETRY_MS || 15000);
let retryTimer = null;
let cleanupRegistered = false;

function reportStatus(patch = {}) {
  runtime.reportStatus({
    workerAlive: true,
    businessReady: patch.businessReady === true,
    phase: patch.phase || 'starting',
    lastError: patch.lastError || '',
    reason: patch.reason || patch.lastError || '',
  });
}

function scheduleRetry() {
  if (retryTimer || process.env.QIANFAN_SIM_MODE === '1') return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void boot();
  }, RETRY_MS);
  if (typeof retryTimer.unref === 'function') retryTimer.unref();
}

async function boot() {
  reportStatus({ phase: 'starting', businessReady: false });
  await stopCallbackServer();

  if (process.env.QIANFAN_SIM_MODE === '1') {
    runtime.onSimInject((message) => {
      if (message.event !== 'wechat-reply') return;
      const traceId = message.meta?.traceId || runtime.newTraceId();
      runtime.publish(
        'wechat.reply.received',
        message.payload,
        { traceId },
      );
    });
    reportStatus({ phase: 'running', businessReady: true });
    return;
  }

  const prep = await prepareWechatRuntime();
  if (!prep.ok) {
    const reason = prep.error?.message || '微信底座启动失败';
    runtime.log('warn', reason);
    reportStatus({ phase: 'degraded', businessReady: false, lastError: reason });
    scheduleRetry();
    return;
  }

  const started = await startCallbackServer(async (line, parsed, body) => {
    const traceId = runtime.newTraceId();
    runtime.publish(
      'wechat.reply.received',
      { line, parsed, body },
      { traceId },
    );
  });

  if (!started.ok) {
    const reason = started.error?.message || '回调服务启动失败';
    runtime.log('warn', reason);
    reportStatus({ phase: 'degraded', businessReady: false, lastError: reason });
    scheduleRetry();
    return;
  }

  reportStatus({ phase: 'running', businessReady: true, lastError: '' });
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    runtime.registerCleanup(async (reason) => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      await stopCallbackServer();
      if (reason === 'app-quit') {
        const { stopWxbotRuntime } = require('../adapters/legacy-wechat-callback-adapter');
        stopWxbotRuntime();
      }
    });
  }
}

boot().catch((err) => {
  const reason = err.message || String(err);
  runtime.log('error', reason);
  reportStatus({ phase: 'degraded', businessReady: false, lastError: reason });
  scheduleRetry();
});
