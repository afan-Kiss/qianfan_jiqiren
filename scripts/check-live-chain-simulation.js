const assert = require('assert');
const { FakeRuntimeHarness, sleep, cleanupTestDir } = require('./sim/fake-runtime-harness');

async function main() {
  const harness = new FakeRuntimeHarness({ runId: 'live-chain' });
  try {
    await harness.start();

    const message = harness.buildBuyerMessage({
      msgId: 'sim-live-chain-buyer-1',
      appCid: 'sim-live-app-cid',
    });
    const traceId = await harness.injectBuyerMessage(message);

    const notified = await harness.waitFor(() => harness.getNotifyCount() >= 1, 12000);
    assert.ok(notified, '微信通知应发送成功');

    const pendingList = harness.readPending();
    assert.ok(pendingList.length > 0, 'pendingReply 应已保存');
    const pending = pendingList.find((p) => p.buyerMsgId === message.msgId) || pendingList[pendingList.length - 1];
    assert.ok(pending?.replyId, 'pendingReply 应包含 replyId');
    assert.ok(pending.status === 'notified' || pending.status === 'pending_notify', 'pending 状态应正确');

    const wxMsgId = await harness.injectWechatReply(
      { replyId: pending.replyId, text: `#${pending.replyId} 链路测试回复` },
      traceId,
    );

    const sent = await harness.waitFor(() => harness.getQianfanSendCount() >= 1, 12000);
    assert.ok(sent, '千帆发送应成功');

    const sentReplies = harness.readSentReplies();
    assert.ok(
      sentReplies.some((r) => Number(r.replyId) === Number(pending.replyId) && r.status === 'sent'),
      'sentReply success 应存在',
    );

    assert.strictEqual(harness.getSuccessReceiptCount(), 0, '不应发送微信成功回执');
    assert.strictEqual(harness.readDeadLetters().length, 0, '成功链路不应产生 deadLetter');

    const qianfanSent = harness.readQianfanSent();
    assert.ok(qianfanSent.length >= 1, 'qianfan 发送记录应存在');
    assert.ok(traceId, 'traceId 应存在');

    console.log('[check-live-chain-simulation] passed');
  } finally {
    const dir = harness.testDataDir;
    await harness.stop();
    cleanupTestDir(dir);
  }
}

main().catch((err) => {
  console.error('[check-live-chain-simulation] FAILED');
  console.error(err.message || err);
  process.exit(1);
});
