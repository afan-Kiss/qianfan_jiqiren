/**
 * 微信 / wxbot 运行时统一恢复（跨 worker 进程互斥）
 */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const config = require('./wxbot-new-config');
const { checkWxbotHealth } = require('../wxbot-new-health');
const { syncWxbotCallbackConfig } = require('../wxbot-new-api');
const { readJson, writeJson } = require('../shared/safe-json-store');

const STATE_FILE = path.join(config.root, 'data', 'wechat-runtime-state.json');
const LOCK_FILE = path.join(config.root, 'data', '.wechat-recovery.lock');
const LOCK_STALE_MS = 5 * 60 * 1000;
const DEFAULT_INJECTION_WAIT_MS = 120000;
const KILL_TARGETS = ['Weixin.exe', 'WeChat.exe', 'wxbot.exe'];
const SEND_FAIL_CONSECUTIVE_THRESHOLD = 3;
const SEND_FAIL_WINDOW_MS = 60000;
const SEND_FAIL_WINDOW_THRESHOLD = 5;
const RECOVERY_RETRY_MS = Number(process.env.WECHAT_RECOVERY_RETRY_MS || 60000);
const STALE_PAUSED_RECOVERY_MS = Number(process.env.WECHAT_STALE_PAUSED_MS || 4 * 60 * 1000);

let inProcessRecoveryPromise = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDataDir() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readState() {
  ensureDataDir();
  const defaults = {
    paused: false,
    pauseReason: '',
    wrongLoginBlocked: false,
    wrongLoginWxid: '',
    lastRecoveryAt: 0,
    lastHealthyAt: 0,
    lastReason: '',
    recoveryInProgress: false,
    nextRecoveryAt: 0,
    pausedAt: 0,
  };
  if (!fs.existsSync(STATE_FILE)) return { ...defaults };
  const parsed = readJson(STATE_FILE, defaults, { critical: true });
  return { ...defaults, ...parsed };
}

function writeState(patch = {}) {
  ensureDataDir();
  const next = { ...readState(), ...patch, updatedAt: Date.now() };
  writeJson(STATE_FILE, next);
  return next;
}

function readLock() {
  if (!fs.existsSync(LOCK_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    return { pid: 0, at: 0, reason: 'invalid-lock' };
  }
}

function tryAcquireLock(reason = 'recover') {
  ensureDataDir();
  const existing = readLock();
  if (existing && Date.now() - Number(existing.at || 0) < LOCK_STALE_MS) {
    return { ok: false, code: 'RECOVERY_LOCKED', holder: existing };
  }
  if (existing) {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {
      // ignore stale lock cleanup errors
    }
  }
  const payload = {
    pid: process.pid,
    reason: String(reason || 'recover'),
    at: Date.now(),
  };
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify(payload), { flag: 'wx' });
    return { ok: true };
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return { ok: false, code: 'RECOVERY_LOCKED', holder: readLock() };
    }
    return { ok: false, code: 'LOCK_FAILED', error: err };
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

function isWechatRuntimePaused() {
  return readState().paused === true;
}

function isWrongLoginBlocked() {
  return readState().wrongLoginBlocked === true;
}

function pauseWechatRuntime(reason = 'recover') {
  return writeState({
    paused: true,
    pauseReason: String(reason || 'recover'),
    pausedAt: Date.now(),
  });
}

function resumeWechatRuntime(extra = {}) {
  return writeState({
    paused: false,
    pauseReason: '',
    resumedAt: Date.now(),
    ...extra,
  });
}

function assertWechatSendAllowed() {
  const state = readState();
  if (state.wrongLoginBlocked) {
    const err = new Error(
      state.wrongLoginWxid
        ? `微信登录 wxid 不匹配（${state.wrongLoginWxid}），已停止自动恢复，请人工确认登录账号`
        : '微信登录 wxid 不匹配，已停止自动恢复，请人工确认登录账号',
    );
    err.code = 'WECHAT_WRONG_LOGIN_BLOCKED';
    throw err;
  }
  if (state.paused) {
    const err = new Error(`微信运行时正在恢复（${state.pauseReason || 'recover'}），暂停发送`);
    err.code = 'WECHAT_RUNTIME_RECOVERING';
    throw err;
  }
}

function clearWrongLoginBlock() {
  return writeState({
    wrongLoginBlocked: false,
    wrongLoginWxid: '',
    wrongLoginReason: '',
  });
}

function ensureWxbotExe() {
  if (!fs.existsSync(config.wxbotExe)) {
    throw new Error(`未找到 wxbot.exe：${config.wxbotExe}`);
  }
}

function killWechatProcesses() {
  if (!config.oneClick.autoKillExistingWechat) {
    for (const proc of ['wxbot.exe']) {
      try {
        execSync(`taskkill /F /IM ${proc}`, { stdio: 'ignore' });
      } catch {
        // ignore
      }
    }
    return { killed: ['wxbot.exe'] };
  }
  const killed = [];
  for (const proc of KILL_TARGETS) {
    try {
      execSync(`taskkill /F /IM ${proc}`, { stdio: 'ignore' });
      killed.push(proc);
    } catch {
      // ignore
    }
  }
  return { killed };
}

function startWxbotProcess() {
  ensureWxbotExe();
  spawn(config.wxbotExe, [], {
    cwd: config.wxbotRuntimeDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  }).unref();
  return { started: true, exe: config.wxbotExe };
}

function isHealthyReport(report) {
  return Boolean(
    report
    && report.ok
    && report.apiOk
    && report.injectOk
    && Number(report.clientId || 0) > 0
    && String(report.wxid || '').trim(),
  );
}

async function evaluateWxbotHealth() {
  const report = await checkWxbotHealth();
  return {
    healthy: isHealthyReport(report),
    report,
    wrongLogin: report.wrongLoginWxid === true,
    reason: report.reason || report.brief || '',
  };
}

async function waitForHealthyInjection(maxWaitMs = DEFAULT_INJECTION_WAIT_MS) {
  const interval = config.oneClick.healthCheckIntervalMs || 2000;
  const started = Date.now();
  let lastReport = null;

  while (Date.now() - started < maxWaitMs) {
    lastReport = await checkWxbotHealth();
    if (lastReport.wrongLoginWxid) return lastReport;
    if (isHealthyReport(lastReport)) return lastReport;
    await sleep(interval);
  }

  return lastReport || checkWxbotHealth();
}

function markWrongLoginBlocked(report, reason) {
  const wxid = String(report?.wxid || '').trim();
  const text = report?.reason
    || `登录 wxid=${wxid || '未知'} 与配置 loginBotWxid=${config.loginBotWxid} 不一致`;
  writeState({
    paused: true,
    pauseReason: 'wrong_login_wxid',
    wrongLoginBlocked: true,
    wrongLoginWxid: wxid,
    wrongLoginReason: text,
    lastRecoveryAt: Date.now(),
    lastReason: reason || 'wrong_login_wxid',
  });
  return text;
}

function blockWrongLoginRecovery(report, reason = 'wrong_login_detected') {
  return markWrongLoginBlocked(report, reason);
}

/**
 * 统一微信运行时恢复入口（全局文件锁 + 进程内 Promise 去重）
 * @param {string} reason
 * @param {{ maxWaitMs?: number, skipKill?: boolean, force?: boolean, onPhase?: Function }} options
 */
async function recoverWechatRuntime(reason = 'recover', options = {}) {
  const state = readState();
  if (state.wrongLoginBlocked && !options.force) {
    return {
      ok: false,
      code: 'WECHAT_WRONG_LOGIN_BLOCKED',
      blocked: true,
      reason: state.wrongLoginReason || '微信登录 wxid 不匹配，已停止自动恢复，请人工确认登录账号',
      report: { wrongLoginWxid: true, wxid: state.wrongLoginWxid },
    };
  }

  if (inProcessRecoveryPromise) {
    return inProcessRecoveryPromise;
  }

  inProcessRecoveryPromise = (async () => {
    const lock = tryAcquireLock(reason);
    if (!lock.ok) {
      return {
        ok: false,
        code: lock.code || 'RECOVERY_LOCKED',
        reason: '另一个进程正在恢复微信运行时',
        holder: lock.holder || null,
      };
    }

    const startedAt = Date.now();
    try {
      pauseWechatRuntime(reason);
      writeState({
        recoveryInProgress: true,
        lastReason: String(reason || 'recover'),
        lastRecoveryAt: startedAt,
      });

      if (options.onPhase) {
        await options.onPhase('pause');
      }

      if (!options.skipKill) {
        killWechatProcesses();
        if (options.onPhase) await options.onPhase('killed');
        await sleep(800);
      }

      startWxbotProcess();
      if (options.onPhase) await options.onPhase('wxbot_started');

      const report = await waitForHealthyInjection(options.maxWaitMs || DEFAULT_INJECTION_WAIT_MS);
      if (report.wrongLoginWxid) {
        const detail = markWrongLoginBlocked(report, reason);
        return {
          ok: false,
          code: 'WECHAT_WRONG_LOGIN',
          blocked: true,
          reason: `${detail}。已停止自动恢复，请退出当前微信并扫码登录机器人号 ${config.robotAccount?.wechatNo || config.loginBotWxid}。`,
          report,
        };
      }

      if (!isHealthyReport(report)) {
        writeState({
          recoveryInProgress: false,
          paused: true,
          pauseReason: reason || 'recover_failed',
          pausedAt: Date.now(),
          lastFailureAt: Date.now(),
          lastFailureReason: report.reason || report.brief || '微信注入未就绪',
          nextRecoveryAt: Date.now() + RECOVERY_RETRY_MS,
        });
        return {
          ok: false,
          code: 'WECHAT_NOT_READY',
          reason: report.reason || report.brief || '微信未就绪',
          report,
        };
      }

      await syncWxbotCallbackConfig();
      if (options.onPhase) await options.onPhase('callback_synced');

      resumeWechatRuntime({
        recoveryInProgress: false,
        wrongLoginBlocked: false,
        wrongLoginWxid: '',
        wrongLoginReason: '',
        lastHealthyAt: Date.now(),
        nextRecoveryAt: 0,
        pauseReason: '',
        lastReport: {
          wxid: report.wxid,
          nickname: report.nickname,
          clientId: report.clientId,
          connectedCount: report.connectedCount,
        },
      });
      clearSendFailureCounters();

      if (options.onPhase) await options.onPhase('resumed');

      return {
        ok: true,
        code: 'RECOVERED',
        reason: '',
        report,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      writeState({
        recoveryInProgress: false,
        paused: true,
        pauseReason: String(reason || 'recover_failed'),
        pausedAt: Date.now(),
        lastFailureAt: Date.now(),
        lastFailureReason: err.message || String(err),
        nextRecoveryAt: Date.now() + RECOVERY_RETRY_MS,
      });
      return {
        ok: false,
        code: 'RECOVERY_FAILED',
        reason: err.message || String(err),
        error: err,
      };
    } finally {
      releaseLock();
      inProcessRecoveryPromise = null;
    }
  })();

  return inProcessRecoveryPromise;
}

function classifyWechatSendFault(err, meta = {}) {
  const code = String(err?.code || '').trim();
  const msg = String(err?.message || err || '').trim();
  const lower = msg.toLowerCase();
  const httpStatus = Number(meta.httpStatus || err?.httpStatus || 0);

  if (code === 'WECHAT_RUNTIME_RECOVERING' || err?.waitingRecovery) {
    return {
      runtimeFault: true,
      waitingRecovery: true,
      errorCode: 'WECHAT_RUNTIME_RECOVERING',
    };
  }

  if (
    code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'ENOTFOUND'
    || code === 'ETIMEDOUT'
    || code === 'UND_ERR_CONNECT_TIMEOUT'
    || /econnrefused|fetch failed|socket hang up|network error|abort|timeout|timed out|无法连接 wxbot/i.test(lower)
  ) {
    return { runtimeFault: true, waitingRecovery: false, errorCode: code || 'WXBOT_API_UNREACHABLE' };
  }

  if (httpStatus === 500 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
    return { runtimeFault: true, waitingRecovery: false, errorCode: `HTTP_${httpStatus}` };
  }

  if (
    meta.injectOk === false
    || meta.clientId === 0
    || /未注入|not inject|client_id|clientid|client id|尚未登录|not connected|微信服务未注入/i.test(lower)
  ) {
    return { runtimeFault: true, waitingRecovery: false, errorCode: 'WXBOT_NOT_INJECTED' };
  }

  return { runtimeFault: false, waitingRecovery: false, errorCode: code || 'WECHAT_SEND_FAILED' };
}

function clearSendFailureCounters() {
  return writeState({
    sendFailures: {
      consecutive: 0,
      timestamps: [],
      clearedAt: Date.now(),
    },
  });
}

function recordWechatSendFault(err, meta = {}) {
  const classified = classifyWechatSendFault(err, meta);
  if (classified.waitingRecovery) {
    return {
      ...classified,
      shouldRecover: false,
      consecutiveFailures: 0,
      windowFailures: 0,
    };
  }

  if (!classified.runtimeFault) {
    return {
      ...classified,
      shouldRecover: false,
      consecutiveFailures: readState().sendFailures?.consecutive || 0,
      windowFailures: (readState().sendFailures?.timestamps || []).length,
    };
  }

  const now = Date.now();
  const prev = readState().sendFailures || { consecutive: 0, timestamps: [] };
  const timestamps = [...(Array.isArray(prev.timestamps) ? prev.timestamps : []), now]
    .filter((ts) => now - ts <= SEND_FAIL_WINDOW_MS);
  const consecutive = Number(prev.consecutive || 0) + 1;
  const sendFailures = {
    consecutive,
    timestamps,
    lastAt: now,
    lastError: String(err?.message || err || ''),
    lastErrorCode: classified.errorCode,
  };
  writeState({ sendFailures });

  const shouldRecover = consecutive >= SEND_FAIL_CONSECUTIVE_THRESHOLD
    || timestamps.length >= SEND_FAIL_WINDOW_THRESHOLD;

  return {
    ...classified,
    shouldRecover,
    consecutiveFailures: consecutive,
    windowFailures: timestamps.length,
    recoverReason: shouldRecover
      ? `send_failures:consecutive=${consecutive},window=${timestamps.length}`
      : '',
  };
}

function enrichWechatSendError(err, meta = {}) {
  if (err && err.runtimeFault !== undefined && err.shouldRecover !== undefined) {
    return err instanceof Error ? err : new Error(String(err || 'wechat send failed'));
  }
  const result = recordWechatSendFault(err, meta);
  const base = err instanceof Error ? err : new Error(String(err || 'wechat send failed'));
  base.code = result.errorCode || base.code || 'WECHAT_SEND_FAILED';
  base.runtimeFault = result.runtimeFault;
  base.waitingRecovery = result.waitingRecovery;
  base.shouldRecover = result.shouldRecover;
  base.consecutiveFailures = result.consecutiveFailures;
  base.windowFailures = result.windowFailures;
  base.recoverReason = result.recoverReason || '';
  if (result.httpStatus) base.httpStatus = result.httpStatus;
  return base;
}

function shouldRetryStalePausedRecovery(state = readState(), now = Date.now()) {
  if (state.wrongLoginBlocked) return false;
  if (!state.paused || state.recoveryInProgress) return false;
  const pausedAt = Number(state.pausedAt || state.lastRecoveryAt || 0);
  const nextAt = Number(state.nextRecoveryAt || 0);
  if (nextAt > 0 && now >= nextAt) return true;
  if (pausedAt > 0 && now - pausedAt >= STALE_PAUSED_RECOVERY_MS) return true;
  return false;
}

function scheduleRecoveryRetry(reason = 'recover_failed') {
  return writeState({
    paused: true,
    pauseReason: String(reason || 'recover_failed'),
    pausedAt: Date.now(),
    recoveryInProgress: false,
    nextRecoveryAt: Date.now() + RECOVERY_RETRY_MS,
  });
}

module.exports = {
  recoverWechatRuntime,
  evaluateWxbotHealth,
  checkWxbotHealth,
  isHealthyReport,
  isWechatRuntimePaused,
  isWrongLoginBlocked,
  pauseWechatRuntime,
  resumeWechatRuntime,
  assertWechatSendAllowed,
  clearWrongLoginBlock,
  blockWrongLoginRecovery,
  killWechatProcesses,
  startWxbotProcess,
  waitForHealthyInjection,
  readWechatRuntimeState: readState,
  classifyWechatSendFault,
  recordWechatSendFault,
  clearSendFailureCounters,
  enrichWechatSendError,
  shouldRetryStalePausedRecovery,
  scheduleRecoveryRetry,
  SEND_FAIL_CONSECUTIVE_THRESHOLD,
  SEND_FAIL_WINDOW_MS,
  SEND_FAIL_WINDOW_THRESHOLD,
  RECOVERY_RETRY_MS,
  STALE_PAUSED_RECOVERY_MS,
};
