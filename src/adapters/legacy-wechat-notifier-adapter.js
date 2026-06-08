const { createQianfanWechatNotifier } = require('../qianfan-wechat-notifier');
const { releaseSeenBuyerMessage } = require('../qianfan-message-listener');
const {
  buyerMessageKeyFromMessage,
  notificationSuccessKey,
} = require('../runtime/idempotency-keys');
const { ok, fail } = require('./adapter-result');

let notifier = null;
let notifierHooks = null;

function ensureNotifier(persistHooks = null) {
  if (persistHooks) notifierHooks = persistHooks;
  if (!notifier) {
    notifier = createQianfanWechatNotifier({
      enabled: true,
      releaseSeenBuyerMessage,
      persistHooks: notifierHooks || undefined,
    });
  }
  return notifier;
}

function createPersistHooks(runtime) {
  return {
    async nextReplyId() {
      const result = await runtime.persist(
        'pendingReply.save',
        { allocateReplyId: true, record: { status: 'allocating' } },
        { idempotencyKey: `next-reply:${runtime.newTraceId()}` },
      );
      return { replyId: result.data?.replyId };
    },
    async saveSessionContext(message) {
      const key = buyerMessageKeyFromMessage(message);
      const result = await runtime.persist(
        'sessionContext.save',
        { message },
        { idempotencyKey: `session-hook:${key}` },
      );
      return result.data?.context || null;
    },
    async appendPending(record) {
      await runtime.persist(
        'pendingReply.save',
        { record },
        { idempotencyKey: `pending:${record.replyId}:${record.buyerMsgId || record.createdAt}` },
      );
    },
    async findOpenPendingForBuyer(message) {
      const key = buyerMessageKeyFromMessage(message);
      const result = await runtime.persist(
        'pendingReply.findOpenForBuyer',
        { message },
        { idempotencyKey: `pending-open:${key}` },
      );
      return result.data?.pending || null;
    },
    async markNotified(message) {
      const key = buyerMessageKeyFromMessage(message);
      await runtime.persist(
        'buyerMessage.markNotified',
        { message },
        { idempotencyKey: `mark-notified:${key}` },
      );
    },
    async releaseNotifyClaim(message) {
      const key = buyerMessageKeyFromMessage(message);
      await runtime.persist(
        'buyerMessage.releaseClaim',
        { message },
        { idempotencyKey: `release-claim:${key}:${Date.now()}` },
      );
    },
    async markPartialNotifyClaim(message) {
      const key = buyerMessageKeyFromMessage(message);
      await runtime.persist(
        'buyerMessage.markPartial',
        { message },
        { idempotencyKey: `mark-partial:${key}` },
      );
    },
    async recordSentNotification(entry) {
      await runtime.persist(
        'notification.recordSuccess',
        { entry },
        {
          idempotencyKey: notificationSuccessKey({
            replyId: entry.replyId,
            receiverWxid: entry.targetWxid,
          }),
        },
      );
    },
  };
}

async function notifyBuyerMessage(message, options = {}) {
  try {
    const hooks = options.persistHooks || null;
    const flushResult = await ensureNotifier(hooks).handleBuyerMessage(message, options);
    if (flushResult?.skipped) {
      return ok({ skipped: true, reason: flushResult.reason || 'skipped' });
    }
    if (flushResult && flushResult.ok === false) {
      return fail(new Error(flushResult.reason || 'WECHAT_NOTIFY_FAILED'), 'WECHAT_NOTIFY_FAILED');
    }
    return ok({
      notified: true,
      replyId: flushResult?.replyId,
      targets: flushResult?.targets,
      sentMessages: flushResult?.sentMessages || [],
      wxMsgId: flushResult?.wxMsgId,
      notifyAllOk: flushResult?.notifyAllOk === true,
      notifyPartial: flushResult?.reason === 'notify_partial',
    });
  } catch (err) {
    return fail(err, 'WECHAT_NOTIFY_FAILED');
  }
}

module.exports = {
  notifyBuyerMessage,
  createPersistHooks,
};
