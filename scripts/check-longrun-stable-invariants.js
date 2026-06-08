const assert = require('assert');
const path = require('path');
const { LongrunHarness } = require('./longrun/longrun-harness');
const { loadScenario } = require('./longrun/scenario-loader');
const { cleanupTestDir } = require('./sim/fake-runtime-harness');
const { runCheckScript } = require('./test-utils/cleanup-runtime');
const { dumpActiveHandles } = require('./test-utils/dump-active-handles');

async function main() {
  const scenario = loadScenario('stable-100days');
  const harness = new LongrunHarness({
    runId: `check-stable-invariants-${Date.now()}`,
    seed: scenario.seed,
    injectDelayMs: 15,
  });

  try {
    await harness.start();
    const result = await harness.runScenario(scenario);
    await harness.stop();

    const metrics = result.metrics;
    assert.strictEqual(result.passed, true, `stable invariants failed: ${metrics.invariantFailures.join('; ')}`);
    assert.strictEqual(metrics.invariantFailures.length, 0);
    assert.strictEqual(metrics.successReceiptsSent, 0);
    assert.ok(metrics.qianfanSendActualAttempts <= metrics.uniqueProcessableWechatReplyKeys);
    assert.ok(metrics.failureReceiptActualSent <= metrics.uniqueFailureReceiptKeys);
    assert.strictEqual(harness.countRunningWorkerPids(), 0);

    console.log(`[check-longrun-stable-invariants] passed report=${path.join(harness.reportDir, 'summary.md')}`);
  } catch (err) {
    dumpActiveHandles('check-longrun-stable-invariants active handles');
    throw err;
  } finally {
    await harness.cleanup(true);
    cleanupTestDir(harness.testDataDir);
  }
}

runCheckScript(main, { label: 'check-longrun-stable-invariants', timeoutMs: 600000 });
