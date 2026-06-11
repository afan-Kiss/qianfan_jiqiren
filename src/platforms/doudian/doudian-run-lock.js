const path = require('path');
const { execSync } = require('child_process');
const { resolveLogsDir } = require('../../shared/app-root');
const {
  inspectLock,
  readLockFile,
  writeLockFile,
  removeLockFile,
  releaseLockIfOwned,
  registerLockCleanup,
  isPidAlive,
} = require('../../shared/run-lock');

const DOUDIAN_LIVE_LOCK_PATH = path.join(resolveLogsDir(), 'runtime', 'doudian-live.lock.json');

function getDoudianLiveLockPath() {
  return DOUDIAN_LIVE_LOCK_PATH;
}

function parseForceKill(argv = []) {
  return argv.includes('--force-kill');
}

function killPid(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0 || n === process.pid) return false;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${n} /F`, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
        windowsHide: true,
      });
    } else {
      process.kill(n, 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

function toExistingTask(lock) {
  if (!lock) return null;
  return {
    pid: Number(lock.pid) || 0,
    command: String(lock.command || ''),
    startedAt: String(lock.startedAt || ''),
    port: Number(lock.port) || 0,
    status: String(lock.status || ''),
  };
}

function inspectDoudianLiveLock(lockPath = DOUDIAN_LIVE_LOCK_PATH) {
  return inspectLock(lockPath);
}

function acquireDoudianLiveLock(options = {}) {
  const lockPath = options.lockPath || getDoudianLiveLockPath();
  const command = String(options.command || 'doudian:live');
  const port = Number(options.port || 19527);
  const forceKill = !!options.forceKill;
  const result = {
    lockPath,
    acquired: false,
    existingTask: null,
    staleLockCleaned: false,
    forceKill,
    reason: '',
  };

  let state = inspectLock(lockPath);

  if (state.exists && state.alive) {
    if (!forceKill) {
      result.existingTask = toExistingTask(state.lock);
      result.reason = 'another_doudian_task_running';
      return result;
    }
    killPid(state.lock.pid);
    removeLockFile(lockPath);
    result.staleLockCleaned = true;
    state = { exists: false, alive: false, stale: false, lock: null };
  } else if (state.exists && state.stale) {
    removeLockFile(lockPath);
    result.staleLockCleaned = true;
  }

  writeLockFile(lockPath, {
    pid: process.pid,
    command,
    startedAt: new Date().toISOString(),
    port,
    cwd: process.cwd(),
    status: 'running',
  });

  result.acquired = true;
  result.reason = result.staleLockCleaned ? 'acquired_after_stale_cleanup' : 'acquired';
  return result;
}

function releaseDoudianLiveLock(lockPath = DOUDIAN_LIVE_LOCK_PATH, pid = process.pid) {
  return releaseLockIfOwned(lockPath, pid);
}

function registerDoudianLiveLockCleanup(lockPath = DOUDIAN_LIVE_LOCK_PATH, pid = process.pid) {
  return registerLockCleanup(lockPath, pid);
}

function shouldProtectLiveLockPid(pid, options = {}) {
  if (options.forceKill) return false;
  const lockPath = options.lockPath || DOUDIAN_LIVE_LOCK_PATH;
  const state = inspectLock(lockPath);
  if (!state.exists || !state.alive || !state.lock) return false;
  return Number(state.lock.pid) === Number(pid);
}

function buildBlockedLiveReport(runLock, extra = {}) {
  return {
    success: false,
    reason: 'another_doudian_task_running',
    runLock: runLock || null,
    portGuard: extra.portGuard || null,
    warnings: [
      `已有抖店 live 任务运行中: pid=${runLock?.existingTask?.pid || ''} command=${runLock?.existingTask?.command || ''}`,
    ],
    nextActions: [
      '等待当前任务结束后再启动新任务',
      '或使用 --force-kill 强制结束旧任务: npm run <command> -- --force-kill',
    ],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...extra,
  };
}

module.exports = {
  DOUDIAN_LIVE_LOCK_PATH,
  getDoudianLiveLockPath,
  parseForceKill,
  inspectDoudianLiveLock,
  acquireDoudianLiveLock,
  releaseDoudianLiveLock,
  registerDoudianLiveLockCleanup,
  shouldProtectLiveLockPid,
  buildBlockedLiveReport,
  readDoudianLiveLock: (lockPath = DOUDIAN_LIVE_LOCK_PATH) => readLockFile(lockPath),
  isPidAlive,
  killPid,
};
