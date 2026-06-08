const { exec } = require('child_process');
const { dumpActiveHandles } = require('./dump-active-handles');

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isPidAlive(pid) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve(false);
      return;
    }
    if (process.platform === 'win32') {
      exec(`tasklist /FI "PID eq ${pid}" /NH`, (err, stdout) => {
        if (err) {
          resolve(false);
          return;
        }
        resolve(String(stdout || '').includes(String(pid)));
      });
      return;
    }
    try {
      process.kill(pid, 0);
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

function killProcessTree(pid) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve();
      return;
    }
    if (process.platform === 'win32') {
      exec(`taskkill /T /F /PID ${pid}`, () => resolve());
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
    resolve();
  });
}

function collectSupervisorPids(supervisor) {
  if (!supervisor?.runners) return [];
  const pids = new Set();
  for (const runner of supervisor.runners.values()) {
    if (runner.pid) pids.add(runner.pid);
    if (runner.child?.pid) pids.add(runner.child.pid);
  }
  return [...pids];
}

async function forceKillPids(pids = []) {
  for (const pid of pids) {
    await killProcessTree(pid);
  }
}

function getSupervisor(harness) {
  if (!harness) return null;
  if (harness.supervisor) return harness.supervisor;
  if (harness.fake?.supervisor) return harness.fake.supervisor;
  return null;
}

async function cleanupRuntime(harness, options = {}) {
  const supervisor = getSupervisor(harness);
  const trackedPids = supervisor ? collectSupervisorPids(supervisor) : [];

  if (supervisor) {
    if (typeof supervisor.cancelAllPendingRestarts === 'function') {
      supervisor.cancelAllPendingRestarts();
    }
    try {
      await supervisor.stopAll(options.reason || 'test-cleanup');
    } catch {
      // ignore stop errors during cleanup
    }
    try {
      supervisor.dispose();
    } catch {
      // ignore dispose errors
    }
  }

  if (harness) {
    if (harness.fake) harness.fake.supervisor = null;
    if (harness.supervisor) harness.supervisor = null;
  }

  await sleep(options.graceMs ?? 300);

  if (trackedPids.length) {
    await forceKillPids(trackedPids);
    await sleep(200);
  }

  if (options.verify !== false) {
    const alive = [];
    for (const pid of trackedPids) {
      if (await isPidAlive(pid)) alive.push(pid);
    }
    if (alive.length) {
      throw new Error(`residual worker pids after cleanup: ${alive.join(', ')}`);
    }
  }

  return { trackedPids, remaining: [] };
}

async function cleanupHarness(harness, options = {}) {
  if (!harness) return { ok: true };

  if (typeof harness.stop === 'function') {
    try {
      await harness.stop({ verify: false, ...options });
    } catch {
      // fall through to supervisor cleanup
    }
  }

  await cleanupRuntime(harness, options);

  if (options.removeData && typeof harness.cleanup === 'function') {
    await harness.cleanup(true);
  } else if (options.removeData && harness.testDataDir) {
    const { cleanupTestDir } = require('../sim/fake-runtime-harness');
    cleanupTestDir(harness.testDataDir);
  }

  return { ok: true };
}

function runCheckScript(mainFn, options = {}) {
  const label = options.label || 'check-script';
  const timeoutMs = options.timeoutMs || 30000;
  const { withHardTimeout } = require('./with-hard-timeout');

  withHardTimeout(Promise.resolve().then(() => mainFn()), timeoutMs, label)
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[${label}] FAILED`);
      console.error(err.message || err);
      dumpActiveHandles(`${label} active handles`);
      process.exit(1);
    });
}

module.exports = {
  sleep,
  killProcessTree,
  isPidAlive,
  collectSupervisorPids,
  forceKillPids,
  cleanupRuntime,
  cleanupHarness,
  runCheckScript,
};
