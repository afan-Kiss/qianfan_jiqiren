const fs = require('fs');
const os = require('os');
const path = require('path');

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function main() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qianfan-send-retry-'));
  process.env.QIANFAN_SIM_DATA_DIR = testDir;

  const adapterPath = path.join(__dirname, '..', 'src/adapters/legacy-data-store-adapter.js');
  const keysPath = path.join(__dirname, '..', 'src/runtime/idempotency-keys.js');
  delete require.cache[adapterPath];
  delete require.cache[keysPath];
  const { handlePersistRequest } = require(adapterPath);
  const { qianfanSendPendingKey, wechatReplyContentKey } = require(keysPath);

  const replyId = 1134;
  const replyText = '嗯嗯';
  const idempotencyKey = qianfanSendPendingKey({ replyId, replyText });

  const firstPending = await handlePersistRequest({
    action: 'qianfanSend.recordPending',
    data: {
      replyId,
      replyText,
      wxMsgId: 'wx-1',
      idempotencyKey,
      traceId: 'trace-1',
    },
    idempotencyKey,
  });
  assert(firstPending.ok && firstPending.data?.created, 'first recordPending should create');

  const duplicateWhilePending = await handlePersistRequest({
    action: 'qianfanSend.recordPending',
    data: { replyId, replyText, wxMsgId: 'wx-2', idempotencyKey, traceId: 'trace-2' },
    idempotencyKey: `${idempotencyKey}:dup`,
  });
  assert(duplicateWhilePending.data?.duplicate, 'pending send should dedup duplicate request');

  await handlePersistRequest({
    action: 'wechatReply.ensureDedup',
    data: {
      wechatReplyMsgId: 'wx-1',
      replyId,
      fromWxid: 'wxid_test',
      text: replyText,
    },
    idempotencyKey: `wechat-reply:${replyId}:wx-1`,
  });

  const blockedByContent = await handlePersistRequest({
    action: 'wechatReply.ensureDedup',
    data: {
      wechatReplyMsgId: 'wx-2',
      replyId,
      fromWxid: 'wxid_test',
      text: replyText,
    },
    idempotencyKey: `wechat-reply:${replyId}:wx-2`,
  });
  assert(blockedByContent.data?.duplicate, 'same content should dedup before send failure is recorded');

  await handlePersistRequest({
    action: 'qianfanSend.recordFailure',
    data: {
      replyId,
      replyText,
      idempotencyKey,
      reason: '店铺页面未接入，请到千帆手动回复',
    },
    idempotencyKey: `qianfan-send-fail:${idempotencyKey}`,
  });

  const retryPending = await handlePersistRequest({
    action: 'qianfanSend.recordPending',
    data: {
      replyId,
      replyText,
      wxMsgId: 'wx-3',
      idempotencyKey,
      traceId: 'trace-3',
    },
    idempotencyKey: `${idempotencyKey}:retry`,
  });
  assert(retryPending.ok && retryPending.data?.created, 'failed send must allow recordPending retry');
  assert(retryPending.data?.retry === true, 'retry should be flagged');

  const retryWechatDedup = await handlePersistRequest({
    action: 'wechatReply.ensureDedup',
    data: {
      wechatReplyMsgId: 'wx-3',
      replyId,
      fromWxid: 'wxid_test',
      text: replyText,
    },
    idempotencyKey: `wechat-reply:${replyId}:wx-3`,
  });
  assert(!retryWechatDedup.data?.duplicate, 'failed send must clear content dedup for retry');

  fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.QIANFAN_SIM_DATA_DIR;
  console.log('[check-qianfan-send-retry] OK');
}

main().catch((err) => {
  console.error('[check-qianfan-send-retry] FAILED');
  console.error(err.message || err);
  process.exit(1);
});
