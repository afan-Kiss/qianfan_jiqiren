const assert = require('assert');
const { LongrunHarness } = require('./longrun/longrun-harness');
const { cleanupTestDir } = require('./sim/fake-runtime-harness');
const { runCheckScript } = require('./test-utils/cleanup-runtime');
const { dumpActiveHandles } = require('./test-utils/dump-active-handles');

async function main() {
  const harness = new LongrunHarness({
    runId: `check-chaos-${Date.now()}`,
    seed: 8008,
    injectDelayMs: 25,
    restartPolicy: { baseDelayMs: 150, maxDelayMs: 600, maxRestartsInWindow: 10 },
  });

  const scenario = {
    name: 'check-longrun-chaos',
    days: 3,
    seed: 8008,
    profile: {
      buyerMessagesPerDay: 6,
      replyRate: 0.7,
      duplicateRate: 0.3,
      outOfOrderRate: 0.1,
      qianfanFailRate: 0.2,
      wechatNotifyFailRate: 0.1,
      crashRate: 0.35,
      timeoutRate: 0.25,
      persistenceDelayRate: 0.15,
    },
  };

  try {
    await harness.start();
    const result = await harness.runScenario(scenario);

    assert.strictEqual(result.metrics.successReceiptsSent, 0);
    assert.ok(result.metrics.workerCrashes + result.metrics.watchdogTimeouts >= 1);
    assert.ok(result.metrics.deadLetters >= 0);
    assert.strictEqual(result.metrics.invariantFailures.length, 0, result.metrics.invariantFailures.join('; '));

    await harness.stop();
    assert.strictEqual(harness.countRunningWorkerPids(), 0);
    console.log('[check-longrun-chaos] passed');
  } catch (err) {
    dumpActiveHandles('check-longrun-chaos active handles');
    throw err;
  } finally {
    await harness.cleanup(true);
    cleanupTestDir(harness.testDataDir);
  }
}

runCheckScript(main, { label: 'check-longrun-chaos', timeoutMs: 45000 });
