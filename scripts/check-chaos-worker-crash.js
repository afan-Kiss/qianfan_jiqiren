const assert = require('assert');
const { FakeRuntimeHarness, cleanupTestDir } = require('./sim/fake-runtime-harness');
const { START_ORDER } = require('../src/runtime/worker-registry');
const { RestartPolicy } = require('../src/runtime/restart-policy');
const { runCheckScript, sleep } = require('./test-utils/cleanup-runtime');
const { dumpActiveHandles } = require('./test-utils/dump-active-handles');

async function testRestartPolicyCircuitBreaker() {
  const policy = new RestartPolicy({ maxRestartsInWindow: 10, windowMs: 10 * 60 * 1000 });
  for (let i = 0; i < 10; i += 1) {
    policy.recordRestart('sim-worker');
  }
  assert.strictEqual(policy.canRestart('sim-worker'), false, '10 分钟内超过 10 次应进入 failed');
  policy.reset('sim-worker');
  assert.strictEqual(policy.canRestart('sim-worker'), true, '手动 reset 后应允许重启');
}

async function testWorkerCrashRecovery(workerName) {
  const harness = new FakeRuntimeHarness({
    runId: `crash-${workerName}`,
    crashWorkers: [workerName],
    restartPolicy: { baseDelayMs: 150, maxDelayMs: 600 },
    startWorkerDelayMs: 50,
  });

  try {
    await harness.start();
    await sleep(1500);

    const crashed = harness.getWorkerStatus(workerName);
    assert.strictEqual(crashed.status, 'running', `${workerName} 崩溃后应恢复 running`);

    const restartCount = crashed.restartPolicy?.restartCount || 0;
    assert.ok(restartCount >= 1, `${workerName} restartCount 应增加`);

    for (const other of START_ORDER) {
      if (other === workerName) continue;
      const status = harness.getWorkerStatus(other);
      assert.notStrictEqual(status.status, 'crashed', `${other} 不应因 ${workerName} 崩溃而 crashed`);
    }

    return true;
  } finally {
    const dir = harness.testDataDir;
    await harness.stop();
    cleanupTestDir(dir);
  }
}

async function main() {
  try {
    await testRestartPolicyCircuitBreaker();

    for (const workerName of START_ORDER) {
      await testWorkerCrashRecovery(workerName);
    }

    console.log('[check-chaos-worker-crash] passed');
  } catch (err) {
    dumpActiveHandles('check-chaos-worker-crash active handles');
    throw err;
  }
}

runCheckScript(main, { label: 'check-chaos-worker-crash', timeoutMs: 90000 });
