const { createWorkerRuntime } = require('./worker-bootstrap');
const { parseWechatReplyContent } = require('../adapters/legacy-wechat-reply-adapter');
const { sendFailureReceipt } = require('../adapters/legacy-qianfan-sender-adapter');
const config = require('../wechat/wxbot-new-config');
const { isAuthorizedReplyWxid, getAuthorizedReplyWxids } = config;
const {
  shouldNotifyInvalidReply,
  formatInvalidReplyReason,
} = require('../wechat-reply-parser');

function resolveReceiverWxid(fromWxid) {
  const from = String(fromWxid || '').trim();
  if (from && isAuthorizedReplyWxid(from)) return from;
  return getAuthorizedReplyWxids()[0] || config.notifyReceiverAccount?.wxid || '';
}
const {
  wechatReplyKey,
  qianfanSendPendingKey,
  failureReceiptKey,
  notificationSuccessKey,
} = require('../runtime/idempotency-keys');
const {
  formatReplySuccessMessage,
  formatReplyFailureMessage,
} = require('../shared/user-activity-log');

const runtime = createWorkerRuntime({ workerName: 'wechat-reply' });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadPendingReply(reply, traceId) {
  const payload = {
    replyId: reply.replyId,
    fromWxid: reply.fromWxid,
    quotedWxMsgId: reply.quotedWxMsgId,
    wxMsgId: reply.wxMsgId,
    quoteText: reply.quoteText || '',
  };
  const retryDelays = [0, 400, 900];
  for (const delayMs of retryDelays) {
    if (delayMs > 0) await sleep(delayMs);
    const pendingResult = await runtime.persist(
      'pendingReply.get',
      payload,
      { idempotencyKey: `pending-get:${reply.replyId}:${delayMs}`, traceId },
    );
    const pending = pendingResult.data?.pending;
    if (pending) return pending;
  }
  return null;
}

async function sendFailureReceiptWithDedup({
  replyId,
  pending,
  reason,
  text,
  fromWxid,
  traceId,
  errorCodeOrType = 'unknown',
}) {
  const receiverWxid = resolveReceiverWxid(fromWxid);
  if (!receiverWxid || config.dryRun) return;

  const receiptKey = failureReceiptKey({ replyId, replyText: text, receiverWxid, errorCodeOrType });
  const dedupResult = await runtime.persist(
    'failureReceipt.ensureNotSent',
    { key: receiptKey, replyId, receiverWxid, errorCodeOrType },
    { idempotencyKey: `failure-check:${receiptKey}`, traceId },
  );

  if (dedupResult.ok && (dedupResult.data?.alreadySent || dedupResult.data?.duplicate)) {
    runtime.log('info', `failure receipt dedup skip replyId=${replyId} type=${errorCodeOrType}`, { traceId });
    return;
  }

  try {
    await sendFailureReceipt({ replyId, pending, reason, text, fromWxid: receiverWxid });
    await runtime.persist(
      'failureReceipt.markSent',
      { key: receiptKey, replyId, receiverWxid },
      { idempotencyKey: receiptKey, traceId },
    );
  } catch (err) {
    await runtime.persist(
      'failureReceipt.markFailed',
      {
        key: receiptKey,
        replyId,
        receiverWxid,
        reason: err.message || String(err),
      },
      { idempotencyKey: `failure-fail:${receiptKey}`, traceId },
    );
    runtime.log('error', `failure receipt send failed: ${err.message}`, { traceId });
  }
}

runtime.onTopic('wechat.reply.received', async (payload, meta) => {
  const traceId = meta.traceId || runtime.newTraceId();
  const parsed = payload.parsed || {};
  const body = payload.body || {};

  const result = await parseWechatReplyContent({ parsed, body });
  if (!result.ok) {
    runtime.log('error', result.error?.message || 'parse failed', { traceId });
    await runtime.persist(
      'deadLetter.record',
      {
        traceId,
        topic: 'wechat.reply.received',
        workerName: 'wechat-reply',
        reason: result.error?.message || 'parse_failed',
        payload,
        error: result.error,
      },
      { idempotencyKey: `dead-letter:parse:${traceId}`, traceId },
    );
    return;
  }

  const data = result.data || {};
  if (data.kind === 'ignored') return;

  if (data.kind === 'notification_map' && data.mapEntry) {
    const entry = data.mapEntry;
    await runtime.persist(
      'notification.recordSuccess',
      { entry },
      {
        idempotencyKey: notificationSuccessKey({
          replyId: entry.replyId,
          receiverWxid: entry.targetWxid || resolveReceiverWxid(parsed.from),
        }),
        traceId,
      },
    );
    runtime.log('info', `notification map recorded wxMsgId=${entry.wxMsgId} replyId=${entry.replyId}`, { traceId });
    return;
  }

  if (data.kind === 'invalid_reply' && data.reply) {
    const reply = data.reply;
    if (shouldNotifyInvalidReply(reply)) {
      const wxid = resolveReceiverWxid(parsed.from);
      if (wxid && !config.dryRun) {
        await sendFailureReceiptWithDedup({
          replyId: reply.replyId || null,
          pending: null,
          reason: formatInvalidReplyReason(reply.reason),
          text: reply.rawText || reply.text || '',
          fromWxid: wxid,
          traceId,
          errorCodeOrType: String(reply.reason || 'INVALID_REPLY').toUpperCase(),
        });
      }
    } else {
      runtime.log('info', `ignored non-reply message from notifier reason=${reply.reason || 'unknown'}`, {
        traceId,
      });
    }
    runtime.publish(
      'qianfan.send.result',
      {
        success: false,
        skipped: true,
        reason: data.reply.reason || 'invalid_reply',
        error: { message: data.reply.reason || 'invalid_reply' },
        traceId,
      },
      meta,
    );
    return;
  }

  if (data.kind !== 'parsed_reply' || !data.reply) return;

  const reply = data.reply;

  const pending = await loadPendingReply(reply, traceId);
  if (!pending) {
    runtime.log('error', `pending reply not found replyId=${reply.replyId}`, { traceId });
    await runtime.persist(
      'deadLetter.record',
      {
        traceId,
        topic: 'wechat.reply.received',
        workerName: 'wechat-reply',
        reason: 'pending_reply_not_found',
        payload: { reply, parsed, body },
      },
      { idempotencyKey: `dead-letter:pending:${reply.replyId}:${reply.wxMsgId}`, traceId },
    );
    await sendFailureReceiptWithDedup({
      replyId: reply.replyId,
      pending: null,
      reason: '找不到对应的待回复编号，可能已过期或未通知',
      text: reply.text,
      fromWxid: reply.fromWxid,
      traceId,
      errorCodeOrType: 'PENDING_MISSING',
    });
    return;
  }

  const dedupKey = wechatReplyKey({
    fromWxid: reply.fromWxid,
    msgId: reply.wxMsgId,
    text: reply.text,
  });

  const dedupResult = await runtime.persist(
    'wechatReply.ensureDedup',
    {
      wechatReplyMsgId: reply.wxMsgId,
      replyId: reply.replyId,
      fromWxid: reply.fromWxid,
      text: reply.text,
    },
    { idempotencyKey: dedupKey, traceId },
  );

  if (!dedupResult.ok) {
    runtime.log('error', `wechat reply dedup check failed replyId=${reply.replyId}`, { traceId });
    await runtime.persist(
      'deadLetter.record',
      {
        traceId,
        topic: 'wechat.reply.received',
        workerName: 'wechat-reply',
        reason: dedupResult.error?.message || 'wechat_reply_dedup_failed',
        payload: { reply, parsed, body },
        error: dedupResult.error,
      },
      { idempotencyKey: `dead-letter:dedup:${reply.replyId}:${reply.wxMsgId}`, traceId },
    );
    await sendFailureReceiptWithDedup({
      replyId: reply.replyId,
      pending,
      reason: '系统繁忙，请稍后重试',
      text: reply.text,
      fromWxid: reply.fromWxid,
      traceId,
      errorCodeOrType: 'DEDUP_PERSIST_FAILED',
    });
    return;
  }

  if (dedupResult.data?.duplicate) {
    runtime.log('info', `duplicate wechat reply skipped replyId=${reply.replyId}`, { traceId });
    return;
  }

  let receiverAppUids = Array.isArray(pending.receiverAppUids)
    ? pending.receiverAppUids.filter(Boolean)
    : [];

  const sendPayload = {
    replyId: reply.replyId,
    replyText: reply.text,
    mode: reply.mode,
    wxMsgId: reply.wxMsgId,
    pending,
    receiverAppUids,
    fromWxid: reply.fromWxid,
    traceId,
    idempotencyKey: qianfanSendPendingKey({ replyId: reply.replyId, replyText: reply.text }),
  };

  runtime.publish('qianfan.send.request', sendPayload, { ...meta, traceId });
});

runtime.onTopic('qianfan.send.result', async (payload, meta) => {
  const traceId = meta.traceId || payload.traceId;
  if (payload.success) {
    const request = payload.request || {};
    const replyId = request.replyId || payload.replyId;
    runtime.userLog(
      formatReplySuccessMessage({
        replyId,
        fromWxid: request.fromWxid || payload.fromWxid,
        pending: request.pending,
        replyText: request.replyText || request.text,
      }),
      { dedupKey: `send-ok:${replyId || traceId}` },
    );
    return;
  }

  runtime.log(
    'error',
    `qianfan send failed: ${payload.error?.message || payload.reason || 'unknown'}`,
    { traceId, topic: 'qianfan.send.result' },
  );

  if (payload.skipped) {
    const request = payload.request || {};
    const reason = String(payload.reason || '');
    if (reason === 'send_in_flight') {
      runtime.userLog(
        formatReplyFailureMessage({
          replyId: payload.replyId || request.replyId,
          fromWxid: request.fromWxid || payload.fromWxid,
          pending: request.pending,
          reason: '上一条回复仍在发送中，请稍候再试',
        }),
        {
          dedupKey: `send-in-flight:${payload.replyId || request.replyId || traceId}`,
          level: 'warn',
        },
      );
    }
    return;
  }

  const request = payload.request || {};
  runtime.userLog(
    formatReplyFailureMessage({
      replyId: payload.replyId || request.replyId,
      fromWxid: request.fromWxid || payload.fromWxid,
      pending: request.pending,
      reason: payload.error?.message || payload.reason || '发送失败',
    }),
    {
      dedupKey: `send-fail:${payload.replyId || request.replyId || traceId}`,
      level: 'error',
    },
  );

  await sendFailureReceiptWithDedup({
    replyId: payload.replyId || request.replyId,
    pending: request.pending,
    reason: payload.error?.message || payload.reason || '千帆发送失败',
    text: request.replyText || request.text || '',
    fromWxid: request.fromWxid || payload.fromWxid,
    traceId,
    errorCodeOrType: payload.error?.code || 'QIANFAN_SEND_FAILED',
  });
});
