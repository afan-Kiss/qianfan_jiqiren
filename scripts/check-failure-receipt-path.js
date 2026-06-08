const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const config = require(path.join(ROOT, 'src/wechat/wxbot-new-config.js'));
const qianfanBridge = require(path.join(ROOT, 'src/qianfan-ws-bridge.js'));
const wechatSendApi = require(path.join(ROOT, 'src/wechat-send-api.js'));

async function main() {
  const sentTexts = [];
  const originalSendWxText = wechatSendApi.sendWxText;
  const originalFindBridge = qianfanBridge.findBridgeByShopTitle;
  const originalSendQianfan = qianfanBridge.sendQianfanTextReply;
  const originalDryRun = config.dryRun;

  config.dryRun = false;
  wechatSendApi.sendWxText = async (wxid, content) => {
    sentTexts.push({ wxid, content });
    return { body: { code: 0 }, wxMsgId: 'mock' };
  };
  qianfanBridge.findBridgeByShopTitle = () => ({ shopTitle: 'mock-shop' });
  qianfanBridge.sendQianfanTextReply = async () => {
    throw new Error('mock qianfan send failure');
  };

  const senderAdapterPath = path.join(ROOT, 'src/adapters/legacy-qianfan-sender-adapter.js');
  delete require.cache[senderAdapterPath];
  const senderAdapter = require(senderAdapterPath);

  try {
    const failResult = await senderAdapter.sendQianfanReplyRequest({
      replyId: 1001,
      replyText: '测试失败回执',
      wxMsgId: 'wx-msg-1',
      fromWxid: 'wxid_notify_test',
      receiverAppUids: ['uid-1'],
      pending: {
        shopTitle: 'mock-shop',
        appCid: 'cid-1',
        buyerNick: '买家A',
        receiverAppUids: ['uid-1'],
      },
    });

    if (failResult.ok) throw new Error('模拟失败时应返回 ok=false');
    if (!failResult.error?.message) throw new Error('失败结果必须包含 error.message');

    const failureReceipt = sentTexts.find((item) => item.content.includes('❌ 回复失败'));
    if (!failureReceipt) throw new Error('千帆发送失败时必须触发微信失败回执');
    if (failureReceipt.wxid !== 'wxid_notify_test') throw new Error('失败回执必须发给 fromWxid 对应通知人');

    const successReceipt = sentTexts.find((item) => item.content.includes('✅ 已回复'));
    if (successReceipt) throw new Error('distributed 路径不应发送微信成功回执');

    qianfanBridge.sendQianfanTextReply = async () => ({ msgId: 'qf-msg-1' });
    sentTexts.length = 0;
    delete require.cache[senderAdapterPath];
    const senderAdapterOk = require(senderAdapterPath);

    const okResult = await senderAdapterOk.sendQianfanReplyRequest({
      replyId: 1002,
      replyText: '测试成功',
      wxMsgId: 'wx-msg-2',
      fromWxid: 'wxid_notify_test',
      receiverAppUids: ['uid-1'],
      pending: {
        shopTitle: 'mock-shop',
        appCid: 'cid-2',
        buyerNick: '买家B',
        receiverAppUids: ['uid-1'],
      },
    });

    if (!okResult.ok || !okResult.data?.success) throw new Error('模拟成功时应返回 ok=true');
    const successReceiptAfterOk = sentTexts.find((item) => item.content.includes('✅') || item.content.includes('已回复'));
    if (successReceiptAfterOk) throw new Error('千帆发送成功时不得发送微信成功回执');
  } finally {
    config.dryRun = originalDryRun;
    wechatSendApi.sendWxText = originalSendWxText;
    qianfanBridge.findBridgeByShopTitle = originalFindBridge;
    qianfanBridge.sendQianfanTextReply = originalSendQianfan;
    delete require.cache[senderAdapterPath];
  }

  console.log('[check-failure-receipt-path] OK');
}

main().catch((err) => {
  console.error('[check-failure-receipt-path] FAILED');
  console.error(err.message || err);
  process.exit(1);
});
