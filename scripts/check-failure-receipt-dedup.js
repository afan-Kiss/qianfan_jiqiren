const path = require('path');
const fs = require('fs');
const config = require('../src/wechat/wxbot-new-config');
const qianfanBridge = require('../src/qianfan-ws-bridge');
const wechatSendApi = require('../src/wechat-send-api');
const { failureReceiptKey } = require('../src/runtime/idempotency-keys');

const ROOT = path.resolve(__dirname, '..');

async function simulateFailureReceiptDedup() {
  const testDataDir = path.join(ROOT, 'data', 'test-runtime', `failure-dedup-${Date.now()}`);
  fs.mkdirSync(testDataDir, { recursive: true });
  process.env.QIANFAN_SIM_DATA_DIR = testDataDir;
  delete require.cache[require.resolve('../src/adapters/legacy-data-store-adapter')];
  const { executeAction } = require('../src/adapters/legacy-data-store-adapter');

  const sentTexts = [];
  const originalSendWxText = wechatSendApi.sendWxText;
  const originalFindBridge = qianfanBridge.findBridgeByShopTitle;
  const originalSendQianfan = qianfanBridge.sendQianfanTextReply;
  const originalDryRun = config.dryRun;

  config.dryRun = false;
  process.env.QIANFAN_DISTRIBUTED_RUNTIME = '1';

  wechatSendApi.sendWxText = async (wxid, content) => {
    sentTexts.push({ wxid, content });
    return { body: { code: 0 }, wxMsgId: 'mock-fail-receipt' };
  };
  qianfanBridge.findBridgeByShopTitle = () => ({ shopTitle: 'mock-shop' });
  qianfanBridge.sendQianfanTextReply = async () => {
    throw new Error('mock qianfan send failure');
  };

  const replyId = 77001 + Math.floor(Math.random() * 1000);
  const replyText = '重复失败回执测试';
  const receiverWxid = 'wxid_failure_dedup_test';
  const receiptKey = failureReceiptKey({ replyId, replyText, receiverWxid });

  const senderAdapterPath = path.join(ROOT, 'src/adapters/legacy-qianfan-sender-adapter.js');
  delete require.cache[senderAdapterPath];
  const senderAdapter = require(senderAdapterPath);

  const request = {
    replyId,
    replyText,
    wxMsgId: 'wx-fail-1',
    fromWxid: receiverWxid,
    receiverAppUids: ['uid-1'],
    pending: {
      shopTitle: 'mock-shop',
      appCid: 'cid-1',
      buyerNick: '买家A',
      receiverAppUids: ['uid-1'],
    },
  };

  try {
    for (let i = 0; i < 2; i++) {
      const failResult = await senderAdapter.sendQianfanReplyRequest(request);
      if (failResult.ok) throw new Error('simulated send should fail');

      await executeAction('qianfanSend.recordFailure', {
        replyId,
        replyText,
        reason: failResult.error?.message,
        idempotencyKey: `qianfan-send:${replyId}:mock`,
      });

      const dedup = await executeAction('failureReceipt.ensureNotSent', { key: receiptKey });
      if (i === 0 && dedup.data?.alreadySent) {
        throw new Error('first failure should not be marked sent yet');
      }

      if (!dedup.data?.alreadySent) {
        const { sendFailureReceipt } = senderAdapter;
        await sendFailureReceipt({
          replyId,
          pending: request.pending,
          reason: failResult.error?.message,
          text: replyText,
          fromWxid: receiverWxid,
        });
        await executeAction('failureReceipt.markSent', {
          key: receiptKey,
          replyId,
          receiverWxid,
        });
      }
    }

    const failureReceipts = sentTexts.filter((item) => item.content.includes('❌ 回复失败'));
    if (failureReceipts.length !== 1) {
      throw new Error(`expected exactly 1 failure receipt, got ${failureReceipts.length}`);
    }
    if (!failureReceipts[0].content.includes(String(replyId))) {
      throw new Error('failure receipt must include replyId');
    }
    if (!failureReceipts[0].content.includes('mock qianfan send failure')) {
      throw new Error('failure receipt must include error.message');
    }
  } finally {
    config.dryRun = originalDryRun;
    wechatSendApi.sendWxText = originalSendWxText;
    qianfanBridge.findBridgeByShopTitle = originalFindBridge;
    qianfanBridge.sendQianfanTextReply = originalSendQianfan;
    delete process.env.QIANFAN_DISTRIBUTED_RUNTIME;
    delete process.env.QIANFAN_SIM_DATA_DIR;
    delete require.cache[senderAdapterPath];
    delete require.cache[require.resolve('../src/adapters/legacy-data-store-adapter')];
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
}

async function main() {
  await simulateFailureReceiptDedup();
  console.log('[check-failure-receipt-dedup] OK');
}

main().catch((err) => {
  console.error('[check-failure-receipt-dedup] FAILED');
  console.error(err.message || err);
  process.exit(1);
});
