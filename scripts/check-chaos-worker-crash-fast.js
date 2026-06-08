const assert = require('assert');
const { FakeRuntimeHarness, cleanupTestDir } = require('./sim/fake-runtime-harness');
const { START_ORDER } = require('../src/runtime/worker-registry');
const { runCheckScript, sleep } = require('./test-utils/cleanup-runtime');
const { dumpActiveHandles } = require('./test-utils/dump-active-handles');

const SAMPLE_WORKERS = ['wechat-reply', 'qianfan-sender'];

async function testWorkerCrashRecovery(workerName) {
  const harness = new FakeRuntimeHarness({
    runId: `crash-fast-${workerName}`,
    crashWorkers: [workerName],
    restartPolicy: { baseDelayMs: 100, maxDelayMs: 400 },
    startWorkerDelayMs: 40,
  });

  const restartCountsBefore = {};
  for (const name of START_ORDER) {
    restartCountsBefore[name] = 0;
  }

  try {
    await harness.start();
    await sleep(1500);

    const crashed = harness.getWorkerStatus(workerName);
    assert.strictEqual(crashed.status, 'running', `${workerName} 崩溃后应恢复 running`);
    assert.ok(crashed.restartPolicy?.restartCount >= 1, `${workerName} restartCount 应增加`);

    for (const other of START_ORDER) {
      if (other === workerName) continue;
      const status = harness.getWorkerStatus(other);
      assert.strictEqual(status.status, 'running', `${other} 应保持 running`);
      assert.strictEqual(
        status.restartPolicy?.restartCount || 0,
        restartCountsBefore[other],
        `${other} 不应因 ${workerName} 崩溃而重启`,
      );
    }

    return true;
  } finally {
    const dir = harness.testDataDir;
    await harness.stop();
    cleanupTestDir(dir);
  }
}

async function main() {
  const started = Date.now();
  try {
    for (const workerName of SAMPLE_WORKERS) {
      await testWorkerCrashRecovery(workerName);
    }

    const elapsed = Date.now() - started;
    assert.ok(elapsed < 15000, `fast crash check must finish within 15s, took ${elapsed}ms`);
    console.log(`[check-chaos-worker-crash-fast] passed in ${elapsed}ms`);
  } catch (err) {
    dumpActiveHandles('check-chaos-worker-crash-fast active handles');
    throw err;
  }
}

runCheckScript(main, { label: 'check-chaos-worker-crash-fast', timeoutMs: 15000 });
