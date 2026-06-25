const { createWorkerRuntime } = require('./worker-bootstrap');
const {
  prepareWechatRuntime,
  recoverWechatRuntime,
  startCallbackServer,
  stopCallbackServer,
  evaluateWxbotHealth,
} = require('../adapters/legacy-wechat-callback-adapter');
const {
  blockWrongLoginRecovery,
  readWechatRuntimeState,
  resumeWechatRuntime,
  shouldRetryStalePausedRecovery,
} = require('../wechat/wechat-runtime-recovery');

const runtime = createWorkerRuntime({ workerName: 'wechat-callback' });
const RETRY_MS = Number(process.env.WECHAT_CALLBACK_RETRY_MS || 15000);
const HEALTH_PROBE_MS = Number(process.env.WECHAT_HEALTH_PROBE_MS || 20000);
const RECOVER_COOLDOWN_MS = Number(process.env.WECHAT_RECOVER_COOLDOWN_MS || 60000);

let retryTimer = null;
let healthProbeTimer = null;
let cleanupRegistered = false;
let recoveryInProgress = false;
let lastRecoveryAttemptAt = 0;
let bootCompleted = false;

function reportStatus(patch = {}) {
  runtime.reportStatus({
    workerAlive: true,
    businessReady: patch.businessReady === true,
    phase: patch.phase || 'starting',
    lastError: patch.lastError || '',
    reason: patch.reason || patch.lastError || '',
    wxbotHealthy: patch.wxbotHealthy,
    wxbotClientId: patch.wxbotClientId,
    wxbotWxid: patch.wxbotWxid,
  });
}

function clearRetryTimer() {
  if (!retryTimer) return;
  clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleRetry(delayMs = RETRY_MS) {
  if (retryTimer || process.env.QIANFAN_SIM_MODE === '1') return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void boot();
  }, delayMs);
  if (typeof retryTimer.unref === 'function') retryTimer.unref();
}

async function restartCallbackServer() {
  await stopCallbackServer();
  return startCallbackServer(async (line, parsed, body) => {
    const traceId = runtime.newTraceId();
    runtime.publish(
      'wechat.reply.received',
      { line, parsed, body },
      { traceId },
    );
  });
}

async function runRecovery(reason, options = {}) {
  if (recoveryInProgress) {
    return { ok: false, skipped: true, reason: 'recovery_in_progress' };
  }
  const now = Date.now();
  if (!options.force && now - lastRecoveryAttemptAt < RECOVER_COOLDOWN_MS) {
    return { ok: false, skipped: true, reason: 'recovery_cooldown' };
  }

  recoveryInProgress = true;
  lastRecoveryAttemptAt = now;
  clearRetryTimer();

  reportStatus({
    phase: 'recovering',
    businessReady: false,
    lastError: `正在恢复微信运行时：${reason}`,
    wxbotHealthy: false,
  });
  runtime.userLog(`检测到微信/wxbot 异常，正在自动恢复（${reason}）`, {
    dedupKey: `wechat-recover-begin:${Math.floor(now / 30000)}`,
    level: 'warn',
  });

  try {
    await stopCallbackServer();

    const recovered = await recoverWechatRuntime(reason, {
      force: options.force === true,
      maxWaitMs: options.maxWaitMs,
      onPhase: async (phase) => {
        runtime.log('info', `wechat recovery phase=${phase} reason=${reason}`);
      },
    });

    if (recovered.blocked) {
      const detail = recovered.reason || '微信登录 wxid 不匹配，已停止自动恢复，请人工确认登录账号';
      runtime.userLog(detail, {
        dedupKey: 'wechat-wrong-login-blocked',
        level: 'error',
      });
      reportStatus({
        phase: 'failed',
        businessReady: false,
        lastError: detail,
        wxbotHealthy: false,
      });
      stopHealthProbe();
      return recovered;
    }

    if (!recovered.ok) {
      const detail = recovered.reason || '微信恢复失败';
      runtime.log('warn', `wechat recovery failed: ${detail}`);
      reportStatus({
        phase: 'degraded',
        businessReady: false,
        lastError: detail,
        wxbotHealthy: false,
      });
      scheduleRetry(RETRY_MS);
      return recovered;
    }

    const started = await restartCallbackServer();
    if (!started.ok) {
      const detail = started.error?.message || '回调服务启动失败';
      runtime.log('warn', detail);
      reportStatus({ phase: 'degraded', businessReady: false, lastError: detail, wxbotHealthy: true });
      scheduleRetry();
      return { ok: false, reason: detail };
    }

    bootCompleted = true;
    runtime.userLog('微信/wxbot 已恢复并完成注入', {
      dedupKey: `wechat-recover-ok:${Math.floor(Date.now() / 30000)}`,
    });
    reportStatus({
      phase: 'running',
      businessReady: true,
      lastError: '',
      wxbotHealthy: true,
      wxbotClientId: recovered.report?.clientId,
      wxbotWxid: recovered.report?.wxid,
    });
    startHealthProbe();
    return { ok: true, report: recovered.report };
  } finally {
    recoveryInProgress = false;
  }
}

async function boot() {
  reportStatus({ phase: 'starting', businessReady: false, wxbotHealthy: false });
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
    reportStatus({ phase: 'running', businessReady: true, wxbotHealthy: true });
    return;
  }

  const prep = await prepareWechatRuntime({
    reason: process.env.WECHAT_MANUAL_PREPARED === '1' ? 'boot_after_manual' : 'boot',
    reuseOnly: process.env.WECHAT_MANUAL_PREPARED === '1',
  });
  if (!prep.ok) {
    const reason = prep.error?.message || '微信底座启动失败';
    runtime.log('warn', reason);
    if (prep.error?.code === 'WECHAT_WRONG_LOGIN' || prep.error?.code === 'WECHAT_WRONG_LOGIN_BLOCKED') {
      runtime.userLog(`${reason}。已停止自动恢复，请人工确认登录账号。`, {
        dedupKey: 'wechat-wrong-login-blocked',
        level: 'error',
      });
      reportStatus({ phase: 'failed', businessReady: false, lastError: reason, wxbotHealthy: false });
      return;
    }
    reportStatus({ phase: 'degraded', businessReady: false, lastError: reason, wxbotHealthy: false });
    scheduleRetry();
    return;
  }

  const started = await restartCallbackServer();
  if (!started.ok) {
    const reason = started.error?.message || '回调服务启动失败';
    runtime.log('warn', reason);
    reportStatus({ phase: 'degraded', businessReady: false, lastError: reason, wxbotHealthy: true });
    scheduleRetry();
    return;
  }

  bootCompleted = true;
  reportStatus({
    phase: 'running',
    businessReady: true,
    lastError: '',
    wxbotHealthy: true,
    wxbotClientId: prep.data?.report?.clientId,
    wxbotWxid: prep.data?.report?.wxid,
  });
  startHealthProbe();

  if (!cleanupRegistered) {
    cleanupRegistered = true;
    runtime.registerCleanup(async (reason) => {
      stopHealthProbe();
      clearRetryTimer();
      await stopCallbackServer();
      if (reason === 'app-quit') {
        const { stopWxbotRuntime } = require('../adapters/legacy-wechat-callback-adapter');
        stopWxbotRuntime();
      }
    });
  }
}

async function probeWxbotHealth() {
  if (process.env.QIANFAN_SIM_MODE === '1' || recoveryInProgress || !bootCompleted) return;

  const runtimeState = readWechatRuntimeState();
  if (runtimeState.wrongLoginBlocked) {
    reportStatus({
      phase: 'failed',
      businessReady: false,
      lastError: runtimeState.wrongLoginReason || '微信登录 wxid 不匹配',
      wxbotHealthy: false,
    });
    return;
  }

  const evaluation = await evaluateWxbotHealth();
  if (evaluation.wrongLogin) {
    const detail = blockWrongLoginRecovery(evaluation.report, 'health_probe');
    runtime.userLog(`${detail}。已停止自动恢复，请人工确认登录账号。`, {
      dedupKey: 'wechat-wrong-login-blocked',
      level: 'error',
    });
    reportStatus({
      phase: 'failed',
      businessReady: false,
      lastError: detail,
      wxbotHealthy: false,
    });
    stopHealthProbe();
    return;
  }

  if (evaluation.healthy) {
    if (runtimeState.paused && !runtimeState.recoveryInProgress) {
      resumeWechatRuntime({
        lastHealthyAt: Date.now(),
        lastReason: 'health_probe_auto_resume',
      });
      runtime.log('info', 'wxbot healthy but paused=true, auto resumed');
    }
    reportStatus({
      phase: 'running',
      businessReady: true,
      lastError: '',
      wxbotHealthy: true,
      wxbotClientId: evaluation.report?.clientId,
      wxbotWxid: evaluation.report?.wxid,
    });
    return;
  }

  if (shouldRetryStalePausedRecovery(runtimeState) && !recoveryInProgress) {
    runtime.log('warn', `wxbot stale paused recovery reason=${runtimeState.pauseReason || 'stale_paused'}`);
    await runRecovery(runtimeState.lastReason || 'stale_paused_recovery');
    return;
  }

  runtime.log('warn', `wxbot unhealthy: ${evaluation.reason || 'unknown'}`);
  await runRecovery(evaluation.reason || 'health_probe_failed');
}

function stopHealthProbe() {
  if (!healthProbeTimer) return;
  clearInterval(healthProbeTimer);
  healthProbeTimer = null;
}

function startHealthProbe() {
  stopHealthProbe();
  if (process.env.QIANFAN_SIM_MODE === '1') return;
  healthProbeTimer = setInterval(() => {
    void probeWxbotHealth().catch((err) => {
      runtime.log('error', `wxbot health probe failed: ${err.message || err}`);
    });
  }, HEALTH_PROBE_MS);
  if (typeof healthProbeTimer.unref === 'function') healthProbeTimer.unref();
}

runtime.onWechatRecover((message = {}) => {
  void runRecovery(message.reason || 'supervisor_request', {
    force: message.force === true,
    maxWaitMs: message.maxWaitMs,
  });
});

boot().catch((err) => {
  const reason = err.message || String(err);
  runtime.log('error', reason);
  reportStatus({ phase: 'degraded', businessReady: false, lastError: reason, wxbotHealthy: false });
  scheduleRetry();
});
