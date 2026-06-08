const assert = require('assert');
const { FakeRuntimeHarness, cleanupTestDir } = require('./sim/fake-runtime-harness');

async function main() {
  const harness = new FakeRuntimeHarness({ runId: 'e2e-idempotency' });
  try {
    await harness.start();

    const message = harness.buildBuyerMessage({
      msgId: 'sim-dedup-buyer-fixed',
      appCid: 'sim-dedup-app-cid',
    });

    const traceId = await harness.injectBuyerMessage(message);
    await harness.waitFor(() => harness.getUniqueBuyerNotifyCount() >= 1, 12000);

    for (let i = 0; i < 2; i += 1) {
      await harness.injectBuyerMessage(message);
      await sleep(400);
    }
    assert.strictEqual(
      harness.getUniqueBuyerNotifyCount(),
      1,
      '同一买家消息不应重复通知（多人通知按 replyId 去重）',
    );

    const pendingList = harness.readPending();
    const pending = pendingList.find((p) => p.buyerMsgId === message.msgId) || pendingList[0];
    assert.ok(pending?.replyId, 'pendingReply 应存在');

    const replyText = `#${pending.replyId} 幂等回复测试`;
    const wxMsgId = `sim-dedup-wx-${pending.replyId}`;
    await harness.injectWechatReply({ replyId: pending.replyId, text: replyText, wxMsgId }, traceId);
    await harness.waitFor(() => harness.getQianfanSendCount() >= 1, 12000);

    for (let i = 0; i < 2; i += 1) {
      await harness.injectWechatReply({ replyId: pending.replyId, text: replyText, wxMsgId }, traceId);
      await sleep(300);
    }
    assert.strictEqual(harness.getQianfanSendCount(), 1, '同一微信回复千帆应只发 1 次');

    await harness.restartWorker('wechat-reply');
    await harness.injectWechatReply({ replyId: pending.replyId, text: replyText, wxMsgId }, traceId);
    await sleep(800);
    assert.strictEqual(harness.getQianfanSendCount(), 1, 'worker 重启后重复回复仍不应重复发送');

    console.log('[check-end-to-end-idempotency] passed (success path)');
  } finally {
    const dir = harness.testDataDir;
    await harness.stop();
    cleanupTestDir(dir);
  }

  const failHarness = new FakeRuntimeHarness({
    runId: 'e2e-failure-receipt',
    simEnv: { QIANFAN_SIM_QIANFAN_SEND_FAIL: '1' },
  });
  try {
    await failHarness.start();
    const message = failHarness.buildBuyerMessage({
      msgId: 'sim-fail-receipt-buyer',
      appCid: 'sim-fail-receipt-cid',
    });
    const traceId = await failHarness.injectBuyerMessage(message);
    await failHarness.waitFor(() => failHarness.getNotifyCount() >= 1, 12000);
    const pending = failHarness.readPending()[0];
    assert.ok(pending?.replyId, 'pending 应存在');

    const replyText = `#${pending.replyId} 失败回执幂等测试`;
    const wxMsgId = `sim-fail-wx-${pending.replyId}`;
    await failHarness.injectWechatReply({ replyId: pending.replyId, text: replyText, wxMsgId }, traceId);
    await failHarness.waitFor(() => failHarness.getFailureReceiptCount() >= 1, 12000);

    for (let i = 0; i < 2; i += 1) {
      await failHarness.injectWechatReply({ replyId: pending.replyId, text: replyText, wxMsgId }, traceId);
      await sleep(500);
    }
    assert.strictEqual(failHarness.getFailureReceiptCount(), 1, '失败回执最多 1 次');
    assert.ok(failHarness.readDeadLetters().length >= 1, '千帆失败应产生 deadLetter');

    console.log('[check-end-to-end-idempotency] passed (failure receipt path)');
  } finally {
    const dir = failHarness.testDataDir;
    await failHarness.stop();
    cleanupTestDir(dir);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('[check-end-to-end-idempotency] FAILED');
  console.error(err.message || err);
  process.exit(1);
});
