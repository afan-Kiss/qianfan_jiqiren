const { createWorkerRuntime } = require('./worker-bootstrap');
const { sendQianfanReplyRequest } = require('../adapters/legacy-qianfan-sender-adapter');
const {
  startBuyerListener,
  stopBuyerListener,
} = require('../adapters/legacy-qianfan-listener-adapter');
const { createQianfanRuntimeController } = require('../adapters/qianfan-runtime-controller');
const { buyerMessageKeyFromMessage } = require('../runtime/idempotency-keys');
const config = require('../wechat/wxbot-new-config');

const runtime = createWorkerRuntime({ workerName: 'qianfan-listener' });

runtime.onTopic('qianfan.send.execute', async (payload, meta) => {
  const traceId = meta.traceId || payload.traceId || runtime.newTraceId();
  const result = await sendQianfanReplyRequest(payload);
  const success = Boolean(result.ok && result.data?.success);

  runtime.publish(
    'qianfan.send.result',
    {
      success,
      replyId: payload.replyId,
      fromWxid: payload.fromWxid,
      traceId,
      request: payload,
      result,
      error: success
        ? undefined
        : {
            message: result.error?.message || result.data?.reason || '千帆发送失败',
            code: result.error?.code || 'QIANFAN_SEND_FAILED',
          },
    },
    { ...meta, traceId },
  );
});

const RETRY_MS = Number(process.env.QIANFAN_LISTENER_RETRY_MS || 30000);
const SHOP_RETRY_MS = Number(process.env.QIANFAN_SHOP_RETRY_MS || 5000);
const PERSIST_RETRY_ATTEMPTS = Number(process.env.QIANFAN_PERSIST_RETRY_ATTEMPTS || 3);
const PERSIST_RETRY_DELAY_MS = Number(process.env.QIANFAN_PERSIST_RETRY_DELAY_MS || 500);
let retryTimer = null;
let runtimeController = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistWithRetry(action, data, options = {}) {
  let lastResult;
  for (let attempt = 0; attempt < PERSIST_RETRY_ATTEMPTS; attempt += 1) {
    lastResult = await runtime.persist(action, data, options);
    if (lastResult.ok) return lastResult;
    if (attempt + 1 < PERSIST_RETRY_ATTEMPTS) {
      await sleep(PERSIST_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  return lastResult;
}

function reportListenerStatus(patch = {}) {
  runtime.reportStatus({
    workerAlive: true,
    ...patch,
  });
}

async function handleBuyerMessage(message, options = {}) {
  const traceId = runtime.newTraceId();
  const idempotencyKey = buyerMessageKeyFromMessage(message);

  const dedupResult = await persistWithRetry(
    'buyerMessage.ensureDedup',
    { message, mode: 'check' },
    { idempotencyKey: `dedup-check:${idempotencyKey}`, traceId },
  );

  if (!dedupResult.ok) {
    runtime.log('error', `buyer dedup persist failed: ${dedupResult.error?.message}`, { traceId });
    await runtime.persist(
      'deadLetter.record',
      {
        traceId,
        topic: 'buyer-message.detected',
        workerName: 'qianfan-listener',
        reason: dedupResult.error?.message || 'persist_timeout',
        payload: { message, options },
        error: dedupResult.error,
      },
      { idempotencyKey: `dead-letter:buyer-dedup:${idempotencyKey}`, traceId },
    );
    return;
  }

  if (dedupResult.data?.duplicate) {
    runtime.log('info', `duplicate buyer message skipped msgId=${message.msgId || ''}`, { traceId });
    return;
  }

  const preview = String(message.text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  runtime.userLog(
    `收到千帆买家消息：${message.shopTitle || '未知店铺'} ${message.buyerNick || '买家'} ${preview || '【空】'}`,
    { dedupKey: `buyer-received:${idempotencyKey}` },
  );

  const sessionResult = await persistWithRetry(
    'sessionContext.save',
    { message },
    { idempotencyKey: `session:${idempotencyKey}`, traceId },
  );
  if (!sessionResult.ok) {
    runtime.log('error', `session persist failed: ${sessionResult.error?.message}`, { traceId });
    await runtime.persist(
      'deadLetter.record',
      {
        traceId,
        topic: 'buyer-message.detected',
        workerName: 'qianfan-listener',
        reason: sessionResult.error?.message || 'persist_timeout',
        payload: { message, options },
        error: sessionResult.error,
      },
      { idempotencyKey: `dead-letter:buyer-session:${idempotencyKey}`, traceId },
    );
    return;
  }

  runtime.publish(
    'buyer-message.detected',
    { message, options, traceId },
    { traceId },
  );
}

function scheduleRetry(delayMs = RETRY_MS) {
  if (retryTimer || process.env.QIANFAN_SIM_MODE === '1') return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void tryStartListener();
  }, delayMs);
  if (typeof retryTimer.unref === 'function') retryTimer.unref();
}

async function tryStartListener() {
  reportListenerStatus({
    phase: 'starting',
    qianfanReady: false,
    listenerReady: false,
  });

  if (process.env.QIANFAN_SIM_MODE === '1') {
    runtime.onSimInject((message) => {
      if (message.event !== 'buyer-message') return;
      void handleBuyerMessage(message.payload.message, message.payload.options || {});
    });
    reportListenerStatus({
      phase: 'running',
      qianfanReady: true,
      listenerReady: true,
    });
    return;
  }

  if (!runtimeController) {
    runtimeController = createQianfanRuntimeController({
      config: { ...config.qianfanDebug, root: config.root },
      log: (level, message) => runtime.log(level, message),
      onPhase: (nextPhase, qianfanRuntime) => {
        const launching = nextPhase === 'checking' || nextPhase === 'launching';
        const waitingShops = nextPhase === 'waiting_shops';
        reportListenerStatus({
          phase: nextPhase,
          qianfanReady: waitingShops,
          listenerReady: false,
          qianfanRuntime,
          reason: waitingShops
            ? '千帆已启动，正在等待店铺工作台页面加载…'
            : launching
              ? '正在通过 cmd 以调试模式启动千帆…'
              : '',
        });
      },
    });
  }

  const readyResult = await runtimeController.ensureQianfanReady();
  const qianfanRuntime = runtimeController.getStatus();
  const qianfanReady = readyResult.phase === 'ready' || readyResult.phase === 'attached';

  if (!qianfanReady) {
    const reason = readyResult.lastError || '千帆未接入，无法启动监听';
    runtime.log(readyResult.phase === 'failed' ? 'error' : 'warn', reason);
    reportListenerStatus({
      phase: readyResult.phase || 'degraded',
      qianfanReady: false,
      listenerReady: false,
      qianfanRuntime,
      reason,
      lastError: reason,
    });
    scheduleRetry();
    return;
  }

  reportListenerStatus({
    phase: 'qianfan_ready',
    qianfanReady: true,
    listenerReady: false,
    qianfanRuntime,
    shopReport: readyResult.attachResult?.shopReport || null,
  });

  const started = await startBuyerListener({
    onBuyerMessage(message, options = {}) {
      void handleBuyerMessage(message, options);
    },
    runtimeController,
    attachResult: readyResult.attachResult,
  });

  if (!started.ok) {
    const reason = started.error?.message || '千帆监听启动失败';
    const waitingShops = /店铺.*加载|工作台页面/.test(reason);
    runtime.log(waitingShops ? 'warn' : 'error', reason);
    reportListenerStatus({
      phase: waitingShops ? 'waiting_shops' : 'degraded',
      qianfanReady: true,
      listenerReady: false,
      qianfanRuntime,
      reason,
      lastError: reason,
    });
    scheduleRetry(waitingShops ? SHOP_RETRY_MS : RETRY_MS);
    return;
  }

  reportListenerStatus({
    phase: 'running',
    qianfanReady: true,
    listenerReady: true,
    qianfanRuntime,
    shopReport: readyResult.attachResult?.shopReport || null,
    lastError: '',
  });

  runtime.registerCleanup(async (reason) => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    await stopBuyerListener();
    if (runtimeController?.stopOwnedQianfan) {
      await runtimeController.stopOwnedQianfan();
    }
    if (reason === 'app-quit') {
      const qianfanCfg = config.qianfanDebug || {};
      if (qianfanCfg.autoCloseExistingQianfanClient !== false) {
        const { killExistingQianfanClient } = require('../qianfan-client-launcher');
        killExistingQianfanClient(qianfanCfg.qianfanClientProcessName || '千帆客服工作台.exe');
      }
    }
  });
}

async function boot() {
  reportListenerStatus({
    phase: 'starting',
    qianfanReady: false,
    listenerReady: false,
  });
  await tryStartListener();
}

boot().catch((err) => {
  const reason = err.message || String(err);
  runtime.log('error', reason);
  reportListenerStatus({
    phase: 'failed',
    qianfanReady: false,
    listenerReady: false,
    reason,
    lastError: reason,
  });
  scheduleRetry();
});
