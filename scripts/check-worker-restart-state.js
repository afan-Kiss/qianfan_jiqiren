const { parseWechatReplyEvent } = require('../src/adapters/legacy-wechat-reply-adapter');
const dataStore = require('../src/qianfan-data-store');
const config = require('../src/wechat/wxbot-new-config');

async function main() {
  const replyId = dataStore.nextReplyId();
  dataStore.appendPending({
    replyId,
    shopTitle: '测试店铺',
    appCid: 'app-cid-test',
    buyerNick: '测试买家',
    receiverAppUids: ['receiver-uid-1'],
    createdAt: Date.now(),
  });

  const pendingBefore = dataStore.findPendingByReplyId(replyId);
  if (!pendingBefore) throw new Error('写入 pending reply 失败');

  // 模拟 worker 进程重启：关键状态必须仍在 data-store 中
  delete require.cache[require.resolve('../src/adapters/legacy-wechat-reply-adapter')];
  delete require.cache[require.resolve('../src/qianfan-data-store')];
  const dataStoreReloaded = require('../src/qianfan-data-store');
  const { parseWechatReplyEvent: parseReloaded } = require('../src/adapters/legacy-wechat-reply-adapter');

  const pendingAfterReload = dataStoreReloaded.findPendingByReplyId(replyId);
  if (!pendingAfterReload) throw new Error('worker 重启后 pending reply 丢失');

  const authorizedWxid = config.authorizedReplyWxid || config.notifyReceiverAccount?.wxid;
  const parsed = {
    from: authorizedWxid,
    wxMsgId: `wx-restart-test-${Date.now()}`,
    content: `#${replyId} 重启后仍可回复`,
  };

  const parseResult = await parseReloaded({ parsed, body: {} });
  if (!parseResult.ok) throw new Error(`重启后解析失败: ${parseResult.error?.message}`);
  if (parseResult.data?.kind !== 'send_request') {
    throw new Error(`重启后应解析为 send_request，实际 ${parseResult.data?.kind}`);
  }
  if (parseResult.data.request.replyId !== replyId) {
    throw new Error('重启后 replyId 映射丢失');
  }

  console.log('[check-worker-restart-state] OK');
}

main().catch((err) => {
  console.error('[check-worker-restart-state] FAILED');
  console.error(err.message || err);
  process.exit(1);
});
