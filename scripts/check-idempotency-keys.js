const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKERS_DIR = path.join(ROOT, 'src/workers');
const keys = require('../src/runtime/idempotency-keys');

const errors = [];

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function assert(cond, message) {
  if (!cond) errors.push(message);
}

function main() {
  const listener = read(path.join(WORKERS_DIR, 'qianfan-listener.worker.js'));
  const notifier = read(path.join(WORKERS_DIR, 'wechat-notifier.worker.js'));
  const reply = read(path.join(WORKERS_DIR, 'wechat-reply.worker.js'));
  const sender = read(path.join(WORKERS_DIR, 'qianfan-sender.worker.js'));

  assert(listener.includes('buyerMessageKeyFromMessage'), 'qianfan-listener must use buyerMessageKeyFromMessage');
  assert(listener.includes('idempotencyKey'), 'qianfan-listener must pass idempotencyKey');
  assert(listener.includes('buyerMessage.ensureDedup'), 'qianfan-listener must call buyerMessage.ensureDedup');

  assert(notifier.includes('buyerMessage.ensureDedup'), 'wechat-notifier must dedup before notify');
  assert(notifier.includes('idempotencyKey'), 'wechat-notifier must pass idempotencyKey');

  assert(reply.includes('wechatReplyKey'), 'wechat-reply must use wechatReplyKey');
  assert(reply.includes('failureReceiptKey'), 'wechat-reply must use failureReceiptKey');
  assert(reply.includes('qianfanSendPendingKey'), 'wechat-reply must use qianfanSendPendingKey');
  assert(reply.includes('wechatReply.ensureDedup'), 'wechat-reply must call wechatReply.ensureDedup');

  assert(sender.includes('qianfanSendPendingKey'), 'qianfan-sender must use qianfanSendPendingKey');
  assert(sender.includes('qianfanSend.recordPending'), 'qianfan-sender must call qianfanSend.recordPending');

  const sampleBuyerKey = keys.buyerMessageKeyFromMessage({ shopTitle: 's', appCid: 'c', buyerNick: 'b', msgId: 'm1' });
  assert(sampleBuyerKey.startsWith('buyer:'), 'buyer key format invalid');

  const sampleNotifyKey = keys.notificationSuccessKey({ replyId: 1, receiverWxid: 'wxid' });
  assert(sampleNotifyKey.startsWith('notify:'), 'notification key format invalid');

  const sampleReplyKey = keys.wechatReplyKey({ fromWxid: 'wx', msgId: 'm', text: 't' });
  assert(sampleReplyKey.startsWith('wechat-reply:'), 'wechat reply key format invalid');

  const sampleSendKey = keys.qianfanSendPendingKey({ replyId: 1, replyText: 'hello' });
  assert(sampleSendKey.startsWith('qianfan-send:'), 'qianfan send key format invalid');

  const normalizedKeyA = keys.qianfanSendPendingKey({
    replyId: 5,
    replyText: '#5 长跑模拟回复 wx-reply-seed-d0-r5',
  });
  const normalizedKeyB = keys.qianfanSendPendingKey({
    replyId: 5,
    replyText: '#5 长跑模拟回复 wx-reply-other',
  });
  assert(normalizedKeyA === normalizedKeyB, 'qianfan send key must normalize reply suffix');

  const parsedSimKeyA = keys.qianfanSendPendingKey({
    replyId: 6,
    replyText: '长跑模拟回复 wx-reply-8008-d0-r6',
  });
  const parsedSimKeyB = keys.qianfanSendPendingKey({
    replyId: 6,
    replyText: '长跑模拟回复 wx-reply-8008-d1-r6',
  });
  assert(parsedSimKeyA === parsedSimKeyB, 'parsed sim reply text must normalize to replyId');

  const sampleFailKey = keys.failureReceiptKey({ replyId: 1, replyText: 'hello', receiverWxid: 'wx' });
  assert(sampleFailKey.startsWith('failure-receipt:'), 'failure receipt key format invalid');

  if (errors.length) {
    console.error('[check-idempotency-keys] FAILED');
    for (const err of errors) console.error(`- ${err}`);
    process.exit(1);
  }

  console.log('[check-idempotency-keys] OK');
}

main();
