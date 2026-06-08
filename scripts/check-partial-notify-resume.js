const assert = require('assert');
const dataStore = require('../src/qianfan-data-store');

function main() {
  const message = {
    shopTitle: '测试店',
    appCid: 'cid-partial-1',
    buyerNick: '买家A',
    msgId: 'msg-partial-1',
    text: '你好',
    createAt: Date.now(),
  };

  dataStore.appendPending({
    replyId: 88001,
    shopTitle: message.shopTitle,
    appCid: message.appCid,
    buyerNick: message.buyerNick,
    buyerMsgId: message.msgId,
    buyerText: message.text,
    createdAt: message.createAt,
    wechatTargets: ['wxid_first'],
    status: 'notify_partial',
  });

  const open = dataStore.findOpenPendingForBuyer(message);
  assert.ok(open, 'open pending should exist for partial notify');
  assert.strictEqual(Number(open.replyId), 88001);
  assert.deepStrictEqual(open.wechatTargets, ['wxid_first']);

  dataStore.appendPending({
    replyId: 88001,
    shopTitle: message.shopTitle,
    appCid: message.appCid,
    buyerNick: message.buyerNick,
    buyerMsgId: message.msgId,
    status: 'notified',
    wechatTargets: ['wxid_first', 'wxid_second'],
    notifiedAt: Date.now(),
  });

  const closed = dataStore.findOpenPendingForBuyer(message);
  assert.strictEqual(closed, null, 'notified pending should not reopen');

  console.log('[check-partial-notify-resume] passed');
}

main();
