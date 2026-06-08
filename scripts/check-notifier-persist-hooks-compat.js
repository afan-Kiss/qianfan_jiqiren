const assert = require('assert');
const path = require('path');
const { createQianfanWechatNotifier, formatWechatNotice } = require('../src/qianfan-wechat-notifier');

async function main() {
  assert.doesNotThrow(() => createQianfanWechatNotifier({ enabled: true }), '不传 persistHooks 应能构造');

  let hookCalled = false;
  const notifier = createQianfanWechatNotifier({
    enabled: true,
    persistHooks: {
      async nextReplyId() {
        return { replyId: 92001 };
      },
      async saveSessionContext() {
        hookCalled = true;
        return { shopTitle: 'hook-shop', appCid: 'hook-cid' };
      },
      async appendPending() {
        hookCalled = true;
      },
      async markNotified() {},
      async recordSentNotification() {},
    },
  });

  assert.ok(typeof notifier.handleBuyerMessage === 'function', '传 persistHooks 后应能调用 handleBuyerMessage');

  const sampleNotice = formatWechatNotice(92001, {
    shopTitle: '测试店铺',
    buyerNick: '测试买家',
    createAt: Date.now(),
    texts: ['测试消息内容'],
  });
  assert.ok(sampleNotice.includes('【千帆待回复 #92001】'), '通知格式必须包含编号标题');
  assert.ok(sampleNotice.includes('测试店铺'), '通知格式必须包含店铺');
  assert.ok(sampleNotice.includes('测试买家'), '通知格式必须包含买家');

  const failingHooks = createQianfanWechatNotifier({
    enabled: true,
    persistHooks: {
      async nextReplyId() {
        throw new Error('sim hook failure');
      },
    },
  });
  assert.doesNotThrow(() => {
    failingHooks.handleBuyerMessage({
      shopTitle: 't',
      appCid: 'c',
      buyerNick: 'b',
      text: 'x',
      createAt: Date.now(),
    });
  }, 'persistHooks 失败时不应导致构造阶段 throw');

  console.log('[check-notifier-persist-hooks-compat] passed');
}

main().catch((err) => {
  console.error('[check-notifier-persist-hooks-compat] FAILED');
  console.error(err.message || err);
  process.exit(1);
});
