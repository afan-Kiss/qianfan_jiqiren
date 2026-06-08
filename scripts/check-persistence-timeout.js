const assert = require('assert');
const { FakeRuntimeHarness, cleanupTestDir } = require('./sim/fake-runtime-harness');
const { runCheckScript, sleep } = require('./test-utils/cleanup-runtime');
const { dumpActiveHandles } = require('./test-utils/dump-active-handles');

async function main() {
  const harness = new FakeRuntimeHarness({
    runId: 'persist-timeout',
    workerExtraEnv: {
      persistence: { QIANFAN_SIM_PERSIST_DELAY_MS: '800' },
      'qianfan-listener': { QIANFAN_SIM_REQUEST_TIMEOUT_MS: '300' },
    },
    startWorkerDelayMs: 80,
  });

  try {
    await harness.start();

    const message = harness.buildBuyerMessage({
      msgId: 'sim-persist-timeout-buyer',
      appCid: 'sim-persist-timeout-cid',
    });

    await harness.injectBuyerMessage(message);
    await sleep(2000);

    const deadLetters = harness.readDeadLetters();
    assert.ok(deadLetters.length >= 1, 'persistence 超时应进入 deadLetter');
    assert.ok(
      deadLetters.some((item) => item.topic === 'buyer-message.detected'),
      'deadLetter 应记录 buyer-message 超时',
    );
    assert.strictEqual(harness.getNotifyCount(), 0, 'persist 超时不应发送微信通知');

    console.log('[check-persistence-timeout] passed');
  } catch (err) {
    dumpActiveHandles('check-persistence-timeout active handles');
    throw err;
  } finally {
    const dir = harness.testDataDir;
    await harness.stop();
    cleanupTestDir(dir);
  }
}

runCheckScript(main, { label: 'check-persistence-timeout', timeoutMs: 30000 });
