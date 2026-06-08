const assert = require('assert');
const { LongrunHarness } = require('./longrun/longrun-harness');
const { getActiveHandlesCount } = require('./longrun/leak-detector');
const { cleanupTestDir } = require('./sim/fake-runtime-harness');
const { runCheckScript } = require('./test-utils/cleanup-runtime');
const { dumpActiveHandles } = require('./test-utils/dump-active-handles');

async function main() {
  const handlesStart = getActiveHandlesCount();
  const harness = new LongrunHarness({
    runId: `check-leaks-${Date.now()}`,
    seed: 7007,
    injectDelayMs: 5,
    leakOptions: { strict: false, maxHandleGrowth: 30, maxMemoryGrowthMB: 200 },
  });

  const scenario = {
    name: 'check-longrun-leaks',
    days: 100,
    seed: 7007,
    fastMode: true,
    batchDays: 5,
    profile: {
      buyerMessagesPerDay: 3,
      replyRate: 0.6,
      duplicateRate: 0.2,
      outOfOrderRate: 0.05,
      qianfanFailRate: 0.05,
      wechatNotifyFailRate: 0.03,
      crashRate: 0.01,
      timeoutRate: 0.01,
      persistenceDelayRate: 0.01,
    },
  };

  try {
    await harness.start();
    await harness.runScenario(scenario);
    await harness.stop();

    const handlesEnd = getActiveHandlesCount();
    const handleGrowth = handlesEnd - handlesStart;
    assert.ok(handleGrowth <= 30, `active handles growth ${handleGrowth} too high`);
    assert.strictEqual(harness.countRunningWorkerPids(), 0);
    assert.strictEqual(harness.metrics.successReceiptsSent, 0);
    assert.strictEqual(harness.metrics.invariantFailures.length, 0);

    console.log('[check-longrun-leaks] passed');
  } catch (err) {
    dumpActiveHandles('check-longrun-leaks active handles');
    throw err;
  } finally {
    await harness.cleanup(true);
    cleanupTestDir(harness.testDataDir);
  }
}

runCheckScript(main, { label: 'check-longrun-leaks', timeoutMs: 45000 });
