const { createWorkerRuntime } = require('./worker-bootstrap');
const {
  qianfanSendPendingKey,
  hashText,
  normalizeReplyTextForDedup,
} = require('../runtime/idempotency-keys');

const runtime = createWorkerRuntime({ workerName: 'qianfan-sender' });
const RETRY_PUMP_MS = Number(process.env.QIANFAN_SEND_RETRY_PUMP_MS || 5000);

let retryPumpRunning = false;
let retryPumpTimer = null;

async function persistSend(action, data, options = {}) {
  return runtime.persist(action, data, {
    idempotencyKey: options.idempotencyKey || `${action}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    traceId: options.traceId || runtime.newTraceId(),
  });
}

async function executeSendRequest(payload, meta = {}) {
  const traceId = meta.traceId || payload.traceId || runtime.newTraceId();
  const replyText = payload.replyText || payload.text || '';
  const normalizedReplyText = normalizeReplyTextForDedup(replyText, payload.replyId);
  const idempotencyKey =
    payload.idempotencyKey || qianfanSendPendingKey({ replyId: payload.replyId, replyText });

  if (!payload.retry) {
    const pendingResult = await persistSend(
      'qianfanSend.recordPending',
      {
        replyId: payload.replyId,
        replyText,
        contentHash: hashText(normalizedReplyText),
        wxMsgId: payload.wxMsgId,
        fromWxid: payload.fromWxid,
        traceId,
        idempotencyKey,
        pending: payload.pending || null,
        receiverAppUids: payload.receiverAppUids || [],
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
  }

  runtime.publish('qianfan.send.execute', { ...payload, idempotencyKey }, { ...meta, traceId });
}

runtime.onTopic('qianfan.send.request', async (payload, meta) => {
  await executeSendRequest(payload, meta);
});

async function syncPendingFromSentConflict(conflict, traceId) {
  const sent = conflict.sentRecord || {};
  const pendingKey = conflict.pendingKey;
  if (!pendingKey || !sent.qianfanMsgId) return;
  await persistSend(
    'qianfanSend.recordSuccess',
    {
      idempotencyKey: pendingKey,
      replyId: conflict.replyId,
      qianfanMsgId: sent.qianfanMsgId,
      syncFromConflict: true,
    },
    { idempotencyKey: `sync-conflict:${pendingKey}`, traceId },
  );
}

async function retryDueSend(entry, traceId) {
  const pendingKey = entry.pendingKey;
  const conflictResult = await persistSend(
    'qianfanSend.checkConflict',
    { replyId: entry.replyId, pendingKey },
    { idempotencyKey: `conflict:${pendingKey}:${traceId}`, traceId },
  );
  const conflict = conflictResult.data || {};
  if (conflict.conflict) {
    runtime.log('warn', conflict.message || `replyId #${entry.replyId} sent/pending conflict`, {
      traceId,
      topic: 'qianfan.send.retry',
    });
    runtime.userLog(conflict.message || `replyId #${entry.replyId} 已在 sent 文件标记成功，跳过补发`, {
      dedupKey: `send-conflict:${entry.replyId}`,
      level: 'warn',
    });
    await syncPendingFromSentConflict(conflict, traceId);
    return;
  }

  const claimResult = await persistSend(
    'qianfanSend.markSending',
    { pendingKey },
    { idempotencyKey: `claim:${pendingKey}:${traceId}`, traceId },
  );
  if (!claimResult.data?.claimed) {
    return;
  }

  const claimed = claimResult.data.entry || entry;
  runtime.log(
    'info',
    `retry pump dispatch replyId=${claimed.replyId} attempt=${(claimed.attempts || 0) + 1} key=${pendingKey}`,
    { traceId, topic: 'qianfan.send.retry' },
  );

  await executeSendRequest(
    {
      replyId: claimed.replyId,
      replyText: claimed.replyText,
      text: claimed.replyText,
      wxMsgId: claimed.wxMsgId,
      fromWxid: claimed.fromWxid,
      pending: claimed.pending,
      receiverAppUids: claimed.receiverAppUids,
      idempotencyKey: pendingKey,
      retry: true,
    },
    { traceId, retry: true },
  );
}

async function runRetryPump() {
  if (retryPumpRunning) return;
  retryPumpRunning = true;
  const traceId = runtime.newTraceId();
  try {
    const listResult = await persistSend(
      'qianfanSend.listDue',
      {},
      { idempotencyKey: `list-due:${Math.floor(Date.now() / RETRY_PUMP_MS)}`, traceId },
    );
    if (!listResult.ok) {
      runtime.log('error', `retry pump listDue failed: ${listResult.error?.message || 'unknown'}`, {
        traceId,
      });
      return;
    }
    const due = Array.isArray(listResult.data?.due) ? listResult.data.due : [];
    for (const entry of due) {
      await retryDueSend(entry, runtime.newTraceId());
    }
  } catch (err) {
    runtime.log('error', `retry pump failed: ${err.message || err}`, { traceId });
  } finally {
    retryPumpRunning = false;
  }
}

function startRetryPump() {
  if (retryPumpTimer) return;
  retryPumpTimer = setInterval(() => {
    void runRetryPump();
  }, RETRY_PUMP_MS);
  if (typeof retryPumpTimer.unref === 'function') retryPumpTimer.unref();
  void runRetryPump();
}

function stopRetryPump() {
  if (!retryPumpTimer) return;
  clearInterval(retryPumpTimer);
  retryPumpTimer = null;
}

startRetryPump();
runtime.registerCleanup(async () => {
  stopRetryPump();
});
