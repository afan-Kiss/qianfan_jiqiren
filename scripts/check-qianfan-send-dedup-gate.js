const assert = require('assert');
const { FakeRuntimeHarness, sleep, cleanupTestDir } = require('./sim/fake-runtime-harness');
const { qianfanSendPendingKey } = require('../src/runtime/idempotency-keys');
const { runCheckScript } = require('./test-utils/cleanup-runtime');
const { dumpActiveHandles } = require('./test-utils/dump-active-handles');

async function main() {
  const harness = new FakeRuntimeHarness({ runId: 'qianfan-send-dedup-gate' });
  try {
    await harness.start();

    const message = harness.buildBuyerMessage({
      msgId: 'sim-dedup-gate-buyer',
      appCid: 'sim-dedup-gate-cid',
    });
    await harness.injectBuyerMessage(message);
    await harness.waitFor(() => harness.getNotifyCount() >= 1, 12000);

    const pending = harness.readPending()[0];
    assert.ok(pending?.replyId, 'pending required');

    const replyText = `#${pending.replyId} 千帆发送幂等闸门测试`;
    const sendPayload = {
      replyId: pending.replyId,
      replyText,
      wxMsgId: `sim-dedup-gate-wx-${pending.replyId}`,
      fromWxid: harness.getAuthorizedWxid(),
      pending,
      receiverAppUids: pending.receiverAppUids || ['uid-1'],
      idempotencyKey: qianfanSendPendingKey({ replyId: pending.replyId, replyText }),
    };

    const sender = harness.supervisor.getRunner('qianfan-sender');
    for (let i = 0; i < 5; i += 1) {
      harness.supervisor.handleWorkerMessage('wechat-reply', {
        type: 'bus.publish',
        topic: 'qianfan.send.request',
        payload: sendPayload,
        meta: { traceId: `dedup-gate-${i}` },
      });
      await sleep(300);
    }

    await sleep(2000);

    const actualAttempts = harness.getQianfanSendCount();

    assert.strictEqual(actualAttempts, 1, `qianfanSendActualAttempts must be 1, got ${actualAttempts}`);
    assert.strictEqual(harness.getQianfanSendCount(), 1, 'qianfan sent log must have 1 entry');
    assert.ok(harness.readSentReplies().length <= 1, 'sentReply should record once');

    console.log('[check-qianfan-send-dedup-gate] passed');
  } catch (err) {
    dumpActiveHandles('check-qianfan-send-dedup-gate active handles');
    throw err;
  } finally {
    const dir = harness.testDataDir;
    await harness.stop();
    cleanupTestDir(dir);
  }
}

runCheckScript(main, { label: 'check-qianfan-send-dedup-gate', timeoutMs: 30000 });
