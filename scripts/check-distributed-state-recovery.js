const path = require('path');
const fs = require('fs');
const config = require('../src/wechat/wxbot-new-config');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  process.env.QIANFAN_DISTRIBUTED_RUNTIME = '1';
  const testDataDir = path.join(ROOT, 'data', 'test-runtime', `state-recovery-${Date.now()}`);
  fs.mkdirSync(testDataDir, { recursive: true });
  process.env.QIANFAN_SIM_DATA_DIR = testDataDir;

  delete require.cache[require.resolve('../src/adapters/legacy-data-store-adapter')];
  const { executeAction } = require('../src/adapters/legacy-data-store-adapter');

  const replyId = 88001;
  await executeAction('pendingReply.save', {
    record: {
      replyId,
      shopTitle: '恢复测试店铺',
      appCid: 'recovery-app-cid',
      buyerNick: '恢复买家',
      receiverAppUids: ['receiver-recovery-1'],
      createdAt: Date.now(),
      status: 'notified',
    },
  });

  const pendingBefore = await executeAction('pendingReply.get', { replyId });
  if (!pendingBefore.ok || !pendingBefore.data?.pending) {
    throw new Error('pendingReply.save failed');
  }

  delete require.cache[require.resolve('../src/adapters/legacy-wechat-reply-adapter')];
  delete require.cache[require.resolve('../src/qianfan-data-store')];
  const { parseWechatReplyContent } = require('../src/adapters/legacy-wechat-reply-adapter');
  const dataStore = require('../src/qianfan-data-store');

  const pendingAfterReload = dataStore.findPendingByReplyId(replyId);
  if (!pendingAfterReload) throw new Error('worker restart simulation: pending lost');

  const authorizedWxid = config.authorizedReplyWxid || config.notifyReceiverAccount?.wxid;
  const wxMsgId = `wx-recovery-${Date.now()}`;
  const parsed = {
    from: authorizedWxid,
    wxMsgId,
    content: `#${replyId} 重启后回复测试`,
  };

  const dedup = await executeAction('wechatReply.ensureDedup', {
    wechatReplyMsgId: wxMsgId,
    replyId,
    fromWxid: authorizedWxid,
    text: '重启后回复测试',
  });
  if (!dedup.ok || dedup.data?.duplicate) throw new Error('fresh wechat reply should not be duplicate');

  const parseResult = await parseWechatReplyContent({ parsed, body: {} });
  if (!parseResult.ok) throw new Error(`parse failed: ${parseResult.error?.message}`);
  if (parseResult.data?.kind !== 'parsed_reply') {
    throw new Error(`expected parsed_reply, got ${parseResult.data?.kind}`);
  }

  const pendingGet = await executeAction('pendingReply.get', { replyId: parseResult.data.reply.replyId });
  if (!pendingGet.data?.pending) throw new Error('pendingReply.get empty after restart');

  const sendPayload = {
    replyId: parseResult.data.reply.replyId,
    replyText: parseResult.data.reply.text,
    wxMsgId,
    pending: pendingGet.data.pending,
    receiverAppUids: pendingGet.data.pending.receiverAppUids,
    fromWxid: authorizedWxid,
  };

  if (!sendPayload.replyId || !sendPayload.pending || !sendPayload.replyText) {
    throw new Error('qianfan.send.request payload incomplete after recovery');
  }

  fs.rmSync(testDataDir, { recursive: true, force: true });
  delete process.env.QIANFAN_SIM_DATA_DIR;
  delete process.env.QIANFAN_DISTRIBUTED_RUNTIME;
  console.log('[check-distributed-state-recovery] OK');
}

main().catch((err) => {
  delete process.env.QIANFAN_SIM_DATA_DIR;
  delete process.env.QIANFAN_DISTRIBUTED_RUNTIME;
  console.error('[check-distributed-state-recovery] FAILED');
  console.error(err.message || err);
  process.exit(1);
});
