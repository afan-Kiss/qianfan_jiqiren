const assert = require('assert');
const { LongrunHarness } = require('./longrun/longrun-harness');
const { loadScenario } = require('./longrun/scenario-loader');
const { cleanupTestDir } = require('./sim/fake-runtime-harness');
const { runCheckScript } = require('./test-utils/cleanup-runtime');
const { dumpActiveHandles } = require('./test-utils/dump-active-handles');

async function main() {
  const started = Date.now();
  const scenario = loadScenario('smoke-1day');
  const harness = new LongrunHarness({
    runId: `check-smoke-${Date.now()}`,
    seed: scenario.seed,
    injectDelayMs: 12,
  });

  try {
    await harness.start();
    const fastScenario = {
      ...scenario,
      profile: {
        ...scenario.profile,
        buyerMessagesPerDay: 6,
        replyRate: 0.5,
        crashRate: 0,
        timeoutRate: 0,
        persistenceDelayRate: 0,
        qianfanFailRate: 0.05,
        wechatNotifyFailRate: 0,
      },
    };
    const result = await harness.runScenario(fastScenario);
    await harness.stop();

    assert.strictEqual(result.metrics.invariantFailures.length, 0, result.metrics.invariantFailures.join('; '));
    assert.strictEqual(result.metrics.successReceiptsSent, 0);
    assert.ok(result.metrics.uniqueBuyerNotifies <= result.metrics.uniqueBuyerMessages);
    assert.strictEqual(harness.countRunningWorkerPids(), 0);

    const elapsed = Date.now() - started;
    assert.ok(elapsed < 30000, `smoke must finish within 30s, took ${elapsed}ms`);
    console.log(`[check-longrun-smoke] passed in ${elapsed}ms`);
  } catch (err) {
    dumpActiveHandles('check-longrun-smoke active handles');
    throw err;
  } finally {
    await harness.cleanup(true);
    cleanupTestDir(harness.testDataDir);
  }
}

runCheckScript(main, { label: 'check-longrun-smoke', timeoutMs: 30000 });
