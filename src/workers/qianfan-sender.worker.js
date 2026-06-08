const { createWorkerRuntime } = require('./worker-bootstrap');
const {
  qianfanSendPendingKey,
  hashText,
  normalizeReplyTextForDedup,
} = require('../runtime/idempotency-keys');

const runtime = createWorkerRuntime({ workerName: 'qianfan-sender' });

runtime.onTopic('qianfan.send.request', async (payload, meta) => {
  const traceId = meta.traceId || payload.traceId || runtime.newTraceId();
  const replyText = payload.replyText || payload.text || '';
  const normalizedReplyText = normalizeReplyTextForDedup(replyText, payload.replyId);
  const idempotencyKey =
    payload.idempotencyKey || qianfanSendPendingKey({ replyId: payload.replyId, replyText });

  const pendingResult = await runtime.persist(
    'qianfanSend.recordPending',
    {
      replyId: payload.replyId,
      replyText,
      contentHash: hashText(normalizedReplyText),
      wxMsgId: payload.wxMsgId,
      fromWxid: payload.fromWxid,
      traceId,
      idempotencyKey,
    },
    { idempotencyKey, traceId },
  );

  if (!pendingResult.ok) {
    runtime.log(
      'error',
      `qianfan send recordPending failed, skip send replyId=${payload.replyId} key=${idempotencyKey}`,
      { traceId, topic: 'qianfan.send.request' },
    );
    runtime.publish(
      'qianfan.send.result',
      {
        success: false,
        reason: 'persist_failed',
        error: pendingResult.error || { message: 'persist_failed' },
        request: payload,
        replyId: payload.replyId,
        traceId,
      },
      { ...meta, traceId },
    );
    return;
  }

  if (pendingResult.data?.alreadyExists || pendingResult.data?.duplicate) {
    runtime.log(
      'info',
      `qianfan send dedup skip replyId=${payload.replyId} key=${idempotencyKey} status=${pendingResult.data?.status || 'unknown'}`,
      { traceId, topic: 'qianfan.send.request' },
    );
    runtime.publish(
      'qianfan.send.result',
      {
        success: pendingResult.data?.status === 'sent',
        skipped: pendingResult.data?.status !== 'sent',
        reason: pendingResult.data?.status === 'sent' ? 'already_sent' : 'send_in_flight',
        request: payload,
        replyId: payload.replyId,
        traceId,
      },
      { ...meta, traceId },
    );
    return;
  }

  if (!pendingResult.data?.created) {
    runtime.log(
      'info',
      `qianfan send not created, skip send replyId=${payload.replyId} key=${idempotencyKey}`,
      { traceId, topic: 'qianfan.send.request' },
    );
    runtime.publish(
      'qianfan.send.result',
      {
        success: false,
        skipped: true,
        reason: 'send_not_created',
        request: payload,
        replyId: payload.replyId,
        traceId,
      },
      { ...meta, traceId },
    );
    return;
  }

  runtime.publish('qianfan.send.execute', payload, { ...meta, traceId });
});
