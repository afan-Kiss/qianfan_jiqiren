const path = require('path');
const { REQUIRED_ACTIONS, executeAction } = require('../src/adapters/legacy-data-store-adapter');
const dataStore = require('../src/qianfan-data-store');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const errors = [];

  for (const action of REQUIRED_ACTIONS) {
    if (typeof action !== 'string' || !action.includes('.')) {
      errors.push(`invalid action name: ${action}`);
    }
  }

  const smokeData = {
    'buyerMessage.ensureDedup': { message: { shopTitle: 't', appCid: 'c', buyerNick: 'b', text: 'hi' } },
    'buyerMessage.markNotified': { message: { shopTitle: 't', appCid: 'c', buyerNick: 'b', text: 'hi' } },
    'buyerMessage.markPartial': {
      message: { shopTitle: 't3', appCid: 'c3', buyerNick: 'b', text: 'partial', msgId: 'm-partial' },
    },
    'buyerMessage.releaseClaim': {
      message: { shopTitle: 't2', appCid: 'c2', buyerNick: 'b', text: 'release', msgId: 'm-release' },
    },
    'notification.recordSuccess': { entry: { wxMsgId: 'wx1', replyId: 9001, targetWxid: 'wxid1' } },
    'notification.recordFailure': { reason: 'test_fail' },
    'wechatReply.ensureDedup': { wechatReplyMsgId: 'wx-reply-1', replyId: 9001, fromWxid: 'wxid1', text: 'ok' },
    'wechatReply.markHandled': { wechatReplyMsgId: 'wx-reply-1', replyId: 9001 },
    'pendingReply.save': { record: { replyId: 9002, shopTitle: 't', appCid: 'c', buyerNick: 'b', createdAt: Date.now() } },
    'pendingReply.get': { replyId: 9002 },
    'pendingReply.resolve': { replyId: 9002 },
    'sentReply.recordSuccess': { replyId: 9002, wechatReplyMsgId: 'wx-r', qianfanMsgId: 'qf-r', text: 'ok' },
    'sentReply.recordFailure': { replyId: 9002, wechatReplyMsgId: 'wx-r', text: 'fail' },
    'sessionContext.save': { message: { shopTitle: 't', appCid: 'c', buyerNick: 'b', text: 'ctx' } },
    'sessionContext.get': { shopTitle: 't', appCid: 'c' },
    'qianfanSend.recordPending': { replyId: 9003, replyText: 'send', idempotencyKey: 'test-pending' },
    'qianfanSend.recordSuccess': { replyId: 9003, replyText: 'send', idempotencyKey: 'test-pending', qianfanMsgId: 'qf1' },
    'qianfanSend.recordFailure': { replyId: 9003, replyText: 'send', idempotencyKey: 'test-pending', reason: 'fail' },
    'failureReceipt.ensureNotSent': { key: 'failure-receipt:test' },
    'failureReceipt.markSent': { key: 'failure-receipt:test', replyId: 9003, receiverWxid: 'wxid1' },
    'failureReceipt.markFailed': { key: 'failure-receipt:test2', replyId: 9003, receiverWxid: 'wxid1', reason: 'fail' },
    'deadLetter.record': { traceId: 't1', topic: 'test', workerName: 'test', reason: 'test', payload: {} },
  };

  for (const action of REQUIRED_ACTIONS) {
    const data = smokeData[action];
    if (!data) {
      errors.push(`missing smoke data for action: ${action}`);
      continue;
    }
    const result = await executeAction(action, data);
    if (!result.ok) {
      errors.push(`action ${action} failed: ${result.error?.message}`);
    }
  }

  const stats = dataStore.getTodayStats();
  if (typeof stats.forwardCount !== 'number' || typeof stats.replyCount !== 'number') {
    errors.push('getTodayStats must return numeric forwardCount/replyCount');
  }

  if (errors.length) {
    console.error('[check-persistence-actions] FAILED');
    for (const err of errors) console.error(`- ${err}`);
    process.exit(1);
  }

  console.log('[check-persistence-actions] OK');
}

main().catch((err) => {
  console.error('[check-persistence-actions] FAILED');
  console.error(err.message || err);
  process.exit(1);
});
