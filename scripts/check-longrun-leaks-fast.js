const assert = require('assert');
const { LongrunHarness } = require('./longrun/longrun-harness');
const { getActiveHandlesCount } = require('./longrun/leak-detector');
const { cleanupTestDir } = require('./sim/fake-runtime-harness');
const { runCheckScript } = require('./test-utils/cleanup-runtime');
const { dumpActiveHandles } = require('./test-utils/dump-active-handles');

async function main() {
  const started = Date.now();
  const handlesStart = getActiveHandlesCount();
  const harness = new LongrunHarness({
    runId: `check-leaks-fast-${Date.now()}`,
    seed: 7071,
    injectDelayMs: 3,
    leakOptions: { strict: false, maxHandleGrowth: 30, maxMemoryGrowthMB: 200 },
  });

  const scenario = {
    name: 'check-longrun-leaks-fast',
    days: 10,
    seed: 7071,
    fastMode: true,
    batchDays: 2,
    profile: {
      buyerMessagesPerDay: 2,
      replyRate: 0.5,
      duplicateRate: 0.1,
      outOfOrderRate: 0.05,
      qianfanFailRate: 0.03,
      wechatNotifyFailRate: 0.02,
      crashRate: 0.005,
      timeoutRate: 0.005,
      persistenceDelayRate: 0.005,
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

    const elapsed = Date.now() - started;
    assert.ok(elapsed < 15000, `fast leaks check must finish within 15s, took ${elapsed}ms`);
    console.log(`[check-longrun-leaks-fast] passed in ${elapsed}ms`);
  } catch (err) {
    dumpActiveHandles('check-longrun-leaks-fast active handles');
    throw err;
  } finally {
    await harness.cleanup(true);
    cleanupTestDir(harness.testDataDir);
  }
}

runCheckScript(main, { label: 'check-longrun-leaks-fast', timeoutMs: 15000 });
