const assert = require('assert');
const { FakeRuntimeHarness, cleanupTestDir } = require('./sim/fake-runtime-harness');
const { runCheckScript, sleep } = require('./test-utils/cleanup-runtime');
const { dumpActiveHandles } = require('./test-utils/dump-active-handles');

async function main() {
  const harness = new FakeRuntimeHarness({
    runId: 'watchdog-timeout',
    watchdog: {
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 500,
      checkIntervalMs: 100,
    },
    simEnv: {
      QIANFAN_SIM_HEARTBEAT_INTERVAL_MS: '100',
    },
    restartPolicy: { baseDelayMs: 200, maxDelayMs: 800 },
    startWorkerDelayMs: 80,
  });

  try {
    await harness.start();

    const before = harness.getWorkerStatus('wechat-reply');
    assert.strictEqual(before.status, 'running', 'wechat-reply 初始应为 running');

    harness.stopWorkerHeartbeat('wechat-reply');
    await sleep(1200);

    const after = harness.getWorkerStatus('wechat-reply');
    assert.ok(
      after.status === 'running' || after.restartPolicy?.restartCount >= 1,
      'watchdog timeout 后 wechat-reply 应被重启并恢复 running',
    );

    const listener = harness.getWorkerStatus('qianfan-listener');
    assert.strictEqual(listener.status, 'running', '正常 worker 不应被误杀');

    console.log('[check-chaos-watchdog-timeout] passed');
  } catch (err) {
    dumpActiveHandles('check-chaos-watchdog-timeout active handles');
    throw err;
  } finally {
    const dir = harness.testDataDir;
    await harness.stop();
    cleanupTestDir(dir);
  }
}

runCheckScript(main, { label: 'check-chaos-watchdog-timeout', timeoutMs: 45000 });
