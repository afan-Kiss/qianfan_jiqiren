#!/usr/bin/env node
/**
 * 抖店 run-lock 专项测试
 * npm run doudian:test-run-lock
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  acquireDoudianLiveLock,
  releaseDoudianLiveLock,
  registerDoudianLiveLockCleanup,
  inspectDoudianLiveLock,
  getDoudianLiveLockPath,
} = require('../src/platforms/doudian/doudian-run-lock');
const { ensurePortAvailable } = require('../src/shared/port-guard');
const { resolveLogsDir } = require('../src/shared/app-root');

function testLockPath() {
  return path.join(resolveLogsDir(), 'runtime', 'doudian-live.test-lock.json');
}

function cleanupTestLock(lockPath) {
  try {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch {
    // ignore
  }
}

function testAcquireOk() {
  const lockPath = testLockPath();
  cleanupTestLock(lockPath);
  const result = acquireDoudianLiveLock({
    command: 'doudian:test-run-lock',
    port: 19527,
    lockPath,
  });
  const ok = result.acquired && result.reason === 'acquired';
  releaseDoudianLiveLock(lockPath);
  cleanupTestLock(lockPath);
  return ok;
}

function testReleaseOk() {
  const lockPath = testLockPath();
  cleanupTestLock(lockPath);
  acquireDoudianLiveLock({ command: 'doudian:test-run-lock', port: 19527, lockPath });
  const released = releaseDoudianLiveLock(lockPath);
  const exists = inspectDoudianLiveLock(lockPath).exists;
  cleanupTestLock(lockPath);
  return released && !exists;
}

function testStaleLockCleanedOk() {
  const lockPath = testLockPath();
  cleanupTestLock(lockPath);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 999999,
      command: 'doudian:stale',
      startedAt: new Date().toISOString(),
      port: 19527,
      cwd: process.cwd(),
      status: 'running',
    })
  );
  const result = acquireDoudianLiveLock({
    command: 'doudian:test-run-lock',
    port: 19527,
    lockPath,
  });
  const ok = result.acquired && result.staleLockCleaned;
  releaseDoudianLiveLock(lockPath);
  cleanupTestLock(lockPath);
  return ok;
}

function spawnHolder(lockPath, port, options = {}) {
  const helper = path.join(process.cwd(), 'scripts', 'test-run-lock-holder.js');
  const args = [helper];
  if (options.forceKill) args.push('--force-kill');
  return spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      DOUDIAN_TEST_LOCK_PATH: lockPath,
      DOUDIAN_TEST_LOCK_PORT: String(port),
      DOUDIAN_TEST_HOLD_PORT: options.holdPort ? '1' : '0',
    },
  });
}

async function waitForHolderReady(child, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = `${child.stdout?.read?.() || ''}`;
    if (text.includes('"acquired":true')) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  const state = inspectDoudianLiveLock(process.env.DOUDIAN_TEST_LOCK_PATH || testLockPath());
  return state.exists && state.alive;
}

async function testRunningTaskBlockedOk() {
  const lockPath = testLockPath();
  cleanupTestLock(lockPath);
  const child = spawnHolder(lockPath, 19527);
  await new Promise((r) => setTimeout(r, 600));
  const blocked = acquireDoudianLiveLock({
    command: 'doudian:test-run-lock-second',
    port: 19527,
    lockPath,
  });
  try {
    child.kill('SIGKILL');
  } catch {
    // ignore
  }
  cleanupTestLock(lockPath);
  return !blocked.acquired && blocked.reason === 'another_doudian_task_running';
}

async function testForceKillOk() {
  const lockPath = testLockPath();
  cleanupTestLock(lockPath);
  const child = spawnHolder(lockPath, 19527);
  await new Promise((r) => setTimeout(r, 600));
  const result = acquireDoudianLiveLock({
    command: 'doudian:test-run-lock-force',
    port: 19527,
    lockPath,
    forceKill: true,
  });
  try {
    child.kill('SIGKILL');
  } catch {
    // ignore
  }
  releaseDoudianLiveLock(lockPath);
  cleanupTestLock(lockPath);
  return result.acquired && result.staleLockCleaned;
}

async function testPortGuardDefaultNoKillOk() {
  const lockPath = testLockPath();
  const port = 19641;
  cleanupTestLock(lockPath);

  const child = spawnHolder(lockPath, port, { holdPort: true });
  await new Promise((r) => setTimeout(r, 900));

  const result = await ensurePortAvailable({
    port,
    host: '127.0.0.1',
    forceKill: false,
    respectLiveLock: true,
    lockPath,
    timeoutMs: 3000,
  });

  try {
    child.kill('SIGKILL');
  } catch {
    // ignore
  }
  cleanupTestLock(lockPath);

  return (
    result.wasOccupied &&
    !result.success &&
    result.reason === 'another_doudian_task_running' &&
    result.killedPids.length === 0
  );
}

async function main() {
  console.log('=== 抖店 run-lock 专项测试 ===');
  const acquireOk = testAcquireOk();
  const releaseOk = testReleaseOk();
  const staleLockCleanedOk = testStaleLockCleanedOk();
  const runningTaskBlockedOk = await testRunningTaskBlockedOk();
  const forceKillOk = await testForceKillOk();
  const portGuardDefaultNoKillOk = await testPortGuardDefaultNoKillOk();

  const summary = {
    success:
      acquireOk &&
      releaseOk &&
      staleLockCleanedOk &&
      runningTaskBlockedOk &&
      forceKillOk &&
      portGuardDefaultNoKillOk,
    acquireOk,
    releaseOk,
    staleLockCleanedOk,
    runningTaskBlockedOk,
    forceKillOk,
    portGuardDefaultNoKillOk,
    lockPath: getDoudianLiveLockPath(),
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.success ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
