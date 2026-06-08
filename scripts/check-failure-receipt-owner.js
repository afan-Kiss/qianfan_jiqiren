const assert = require('assert');
const { FakeRuntimeHarness, sleep, cleanupTestDir } = require('./sim/fake-runtime-harness');
const { runCheckScript } = require('./test-utils/cleanup-runtime');
const { dumpActiveHandles } = require('./test-utils/dump-active-handles');

async function main() {
  const harness = new FakeRuntimeHarness({ runId: 'failure-receipt-owner' });
  try {
    await harness.start();

    const message = harness.buildBuyerMessage({
      msgId: 'sim-failure-owner-buyer',
      appCid: 'sim-failure-owner-cid',
    });
    await harness.injectBuyerMessage(message);
    await harness.waitFor(() => harness.getNotifyCount() >= 1, 12000);

    const pending = harness.readPending()[0];
    assert.ok(pending?.replyId, 'pending required');

    const replyText = `#${pending.replyId} 失败回执唯一负责人测试`;
    const failPayload = {
      success: false,
      replyId: pending.replyId,
      fromWxid: harness.getAuthorizedWxid(),
      traceId: 'failure-owner-trace',
      request: {
        replyId: pending.replyId,
        replyText,
        text: replyText,
        wxMsgId: `sim-failure-owner-wx-${pending.replyId}`,
        fromWxid: harness.getAuthorizedWxid(),
        pending,
      },
      error: { message: 'mock qianfan send failure', code: 'QIANFAN_SEND_FAILED' },
    };

    const replyWorker = harness.supervisor.getRunner('wechat-reply');
    for (let i = 0; i < 5; i += 1) {
      replyWorker.send({
        type: 'bus.message',
        topic: 'qianfan.send.result',
        payload: failPayload,
        meta: { traceId: `failure-owner-${i}` },
      });
      await sleep(250);
    }

    await harness.waitFor(() => harness.getFailureReceiptCount() >= 1, 8000);

    const failureMap = harness.readFailureReceiptMap();
    const sentKeys = Object.entries(failureMap).filter(([, entry]) => entry?.status === 'sent');

    assert.strictEqual(harness.getFailureReceiptCount(), 1, 'failureReceiptActualSent must be 1');
    assert.strictEqual(sentKeys.length, 1, 'uniqueFailureReceiptKeys must be 1');
    assert.strictEqual(harness.getSuccessReceiptCount(), 0, 'success receipts must stay 0');

    console.log('[check-failure-receipt-owner] passed');
  } catch (err) {
    dumpActiveHandles('check-failure-receipt-owner active handles');
    throw err;
  } finally {
    const dir = harness.testDataDir;
    await harness.stop();
    cleanupTestDir(dir);
  }
}

runCheckScript(main, { label: 'check-failure-receipt-owner', timeoutMs: 30000 });
