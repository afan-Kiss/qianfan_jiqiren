const assert = require('assert');
const { LongrunHarness } = require('./longrun/longrun-harness');
const { EventGenerator } = require('./longrun/event-generator');
const { cleanupTestDir, sleep } = require('./sim/fake-runtime-harness');
const { runCheckScript } = require('./test-utils/cleanup-runtime');
const { dumpActiveHandles } = require('./test-utils/dump-active-handles');

async function main() {
  const harness = new LongrunHarness({
    runId: `check-idempotency-${Date.now()}`,
    seed: 9001,
    injectDelayMs: 10,
  });

  try {
    await harness.start();
    const generator = new EventGenerator({ seed: 9001, clock: harness.clock, runId: harness.runId });
    const buyer = generator.nextBuyerMessage(0);

    await harness.processBuyerEvent(buyer);
    await sleep(600);

    for (let i = 0; i < 999; i += 1) {
      await harness.injectBuyerMessage(generator.duplicateEvent(buyer));
    }
    await sleep(300);

    const uniqueNotifies = harness.fake.getUniqueBuyerNotifyCount();
    assert.strictEqual(uniqueNotifies, 1, `unique buyer notifications must be 1, got ${uniqueNotifies}`);

    const pendingList = harness.fake.readPending();
    assert.ok(pendingList.length > 0 || harness.fake.getNotifyCount() > 0, 'pending or notify required');
    const pending = (await harness.resolvePendingFromNotify()) || pendingList[pendingList.length - 1];
    assert.ok(pending?.replyId, 'pending replyId required');

    const reply = generator.nextWechatReply({ replyId: pending.replyId, traceId: 'trace-idem' }, 0);
    await harness.injectWechatReply(reply, 'trace-idem');
    for (let i = 0; i < 2; i += 1) {
      await harness.injectWechatReply(generator.duplicateEvent(reply), 'trace-idem');
    }
    await sleep(300);

    assert.strictEqual(harness.fake.getQianfanSendCount(), 1, 'qianfan send must dedup to 1');
    assert.ok(harness.fake.getFailureReceiptCount() <= 1, 'failure receipt dedup');

    harness.syncMetricsFromStore();
    harness.assertInvariants(true);
    assert.strictEqual(harness.metrics.invariantFailures.length, 0);
    assert.strictEqual(harness.metrics.successReceiptsSent, 0);
    assert.strictEqual(harness.metrics.buyerMessagesGenerated, 1000);

    console.log('[check-longrun-idempotency] passed');
  } catch (err) {
    dumpActiveHandles('check-longrun-idempotency active handles');
    throw err;
  } finally {
    await harness.cleanup(true);
    cleanupTestDir(harness.testDataDir);
  }
}

runCheckScript(main, { label: 'check-longrun-idempotency', timeoutMs: 45000 });
