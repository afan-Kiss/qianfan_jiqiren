const { createWorkerRuntime } = require('./worker-bootstrap');
const { handlePersistRequest } = require('../adapters/legacy-data-store-adapter');
const {
  notificationSuccessKey,
  qianfanSendPendingKey,
  qianfanSendSuccessKey,
  hashText,
} = require('../runtime/idempotency-keys');

async function maybeDelay() {
  let delayMs = Number(process.env.QIANFAN_SIM_PERSIST_DELAY_MS || 0);
  if (process.env.QIANFAN_SIM_MODE === '1') {
    try {
      const { readState } = require('../../scripts/sim/sim-chaos-state');
      delayMs = Math.max(delayMs, Number(readState().persistenceDelayMs || 0));
    } catch {
      // ignore
    }
  }
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

const runtime = createWorkerRuntime({ workerName: 'persistence' });

function buildPersistResult(payload, result, meta) {
  return {
    action: payload.action,
    ok: result.ok,
    data: result.data,
    error: result.error,
    idempotencyKey: payload.idempotencyKey,
    traceId: payload.traceId || meta.traceId,
  };
}

runtime.onTopic('task.persist.request', async (payload, meta) => {
  await maybeDelay();
  const result = await handlePersistRequest(payload);
  if (!result.ok) {
    runtime.log('error', `persist action=${payload.action} failed: ${result.error?.message || 'unknown'}`, {
      traceId: meta.traceId,
      topic: 'task.persist.request',
    });
  }
  runtime.publish(
    'task.persist.result',
    buildPersistResult(payload, result, meta),
    {
      ...meta,
      replyTo: meta.replyTo || payload.sourceWorker,
      requestId: meta.requestId,
    },
  );
});

runtime.onTopic('wechat.notify.result', async (payload, meta) => {
  const traceId = meta.traceId || payload.traceId;
  const request = payload.request || {};
  const message = request.message ?? request;
  const result = payload.result || {};

  if (payload.success) {
    const notifyData = result.data || {};
    const replyId = notifyData.replyId || payload.replyId;
    const sentMessages = Array.isArray(notifyData.sentMessages) ? notifyData.sentMessages : [];
    const targetList = Array.isArray(notifyData.targets) && notifyData.targets.length
      ? notifyData.targets
      : (notifyData.targetWxid ? [notifyData.targetWxid] : []);
    const wxMsgId = notifyData.wxMsgId || payload.wxMsgId;

    const persistEntry = async (entry, receiverWxid) => {
      await handlePersistRequest({
        action: 'notification.recordSuccess',
        data: { entry },
        idempotencyKey: notificationSuccessKey({
          replyId: entry.replyId || replyId || 'unknown',
          receiverWxid: receiverWxid || entry.targetWxid || 'default',
        }),
        traceId,
        sourceWorker: 'persistence',
        createdAt: Date.now(),
      });
    };

    if (sentMessages.length) {
      for (const item of sentMessages) {
        const receiverWxid = String(item.wxid || item.targetWxid || '').trim();
        const messageWxId = String(item.wxMsgId || '').trim();
        if (!receiverWxid || !messageWxId) continue;
        await persistEntry({
          wxMsgId: messageWxId,
          replyId,
          shopTitle: message?.shopTitle,
          appCid: message?.appCid,
          buyerNick: message?.buyerNick,
          sentAt: Date.now(),
          targetWxid: receiverWxid,
        }, receiverWxid);
      }
    } else if (targetList.length === 1 && replyId && wxMsgId) {
      await persistEntry({
        wxMsgId,
        replyId,
        shopTitle: message?.shopTitle,
        appCid: message?.appCid,
        buyerNick: message?.buyerNick,
        sentAt: Date.now(),
        targetWxid: targetList[0],
      }, targetList[0]);
    }
  } else {
    await handlePersistRequest({
      action: 'notification.recordFailure',
      data: {
        reason: payload.error?.message || result.error?.message || 'notify_failed',
        request: payload,
      },
      idempotencyKey: `notify-fail:${traceId}`,
      traceId,
      sourceWorker: 'persistence',
      createdAt: Date.now(),
    });
  }
});

runtime.onTopic('qianfan.send.result', async (payload, meta) => {
  const traceId = meta.traceId || payload.traceId;
  const request = payload.request || {};
  const replyId = payload.replyId || request.replyId;
  const replyText = request.replyText || request.text || '';
  const contentHash = hashText(replyText);
  const pendingKey = request.idempotencyKey || qianfanSendPendingKey({ replyId, replyText });
  const successKey = qianfanSendSuccessKey({ replyId, replyText });
  const qianfanMsgId = String(
    payload.result?.data?.qianfanMsgId || payload.qianfanMsgId || '',
  ).trim();

  if (payload.success) {
    if (!qianfanMsgId) {
      runtime.log(
        'warn',
        `qianfan send success without qianfanMsgId replyId=${replyId}, treat as failure for retry`,
        { traceId },
      );
      const failResult = await handlePersistRequest({
        action: 'qianfanSend.recordFailure',
        data: {
          replyId,
          replyText,
          contentHash,
          idempotencyKey: pendingKey,
          wxMsgId: request.wxMsgId,
          reason: 'missing_qianfan_msg_id',
        },
        idempotencyKey: `qianfan-send-fail:${pendingKey}:${Date.now()}`,
        traceId,
        sourceWorker: 'persistence',
        createdAt: Date.now(),
      });
      if (failResult.data?.finalFailure) {
        await handlePersistRequest({
          action: 'sentReply.recordFailure',
          data: {
            replyId,
            wechatReplyMsgId: request.wxMsgId,
            text: replyText,
            reason: 'missing_qianfan_msg_id',
          },
          idempotencyKey: `sent-reply-fail:${pendingKey}:final`,
          traceId,
          sourceWorker: 'persistence',
          createdAt: Date.now(),
        });
      }
      return;
    }

    await handlePersistRequest({
      action: 'qianfanSend.recordSuccess',
      data: {
        replyId,
        replyText,
        contentHash,
        idempotencyKey: pendingKey,
        qianfanMsgId,
      },
      idempotencyKey: successKey,
      traceId,
      sourceWorker: 'persistence',
      createdAt: Date.now(),
    });
    await handlePersistRequest({
      action: 'sentReply.recordSuccess',
      data: {
        replyId,
        wechatReplyMsgId: request.wxMsgId,
        qianfanMsgId,
        text: replyText,
      },
      idempotencyKey: `sent-reply-success:${successKey}`,
      traceId,
      sourceWorker: 'persistence',
      createdAt: Date.now(),
    });
    await handlePersistRequest({
      action: 'pendingReply.resolve',
      data: { replyId },
      idempotencyKey: `pending-resolve:${replyId}`,
      traceId,
      sourceWorker: 'persistence',
      createdAt: Date.now(),
    });
    await handlePersistRequest({
      action: 'wechatReply.markHandled',
      data: {
        replyId,
        wechatReplyMsgId: request.wxMsgId,
      },
      idempotencyKey: `wechat-handled:${request.wxMsgId}:${replyId}`,
      traceId,
      sourceWorker: 'persistence',
      createdAt: Date.now(),
    });
  } else if (!payload.skipped) {
    const failResult = await handlePersistRequest({
      action: 'qianfanSend.recordFailure',
      data: {
        replyId,
        replyText,
        contentHash,
        idempotencyKey: pendingKey,
        wxMsgId: request.wxMsgId,
        reason: payload.error?.message || payload.reason || 'send_failed',
      },
      idempotencyKey: `qianfan-send-fail:${pendingKey}:${Date.now()}`,
      traceId,
      sourceWorker: 'persistence',
      createdAt: Date.now(),
    });

    if (failResult.data?.finalFailure) {
      await handlePersistRequest({
        action: 'sentReply.recordFailure',
        data: {
          replyId,
          wechatReplyMsgId: request.wxMsgId,
          text: replyText,
          reason: payload.error?.message || payload.reason,
        },
        idempotencyKey: `sent-reply-fail:${pendingKey}:final`,
        traceId,
        sourceWorker: 'persistence',
        createdAt: Date.now(),
      });
      await handlePersistRequest({
        action: 'deadLetter.record',
        data: {
          traceId,
          topic: 'qianfan.send.result',
          workerName: 'qianfan-sender',
          reason: payload.error?.message || payload.reason || 'qianfan_send_failed',
          payload,
          error: payload.error,
        },
        idempotencyKey: `dead-letter:qianfan-send:${pendingKey}:final`,
        traceId,
        sourceWorker: 'persistence',
        createdAt: Date.now(),
      });
    } else {
      runtime.log(
        'info',
        `qianfan send scheduled retry replyId=${replyId} attempts=${failResult.data?.attempts || '?'} retryAt=${failResult.data?.retryAt || ''}`,
        { traceId, topic: 'qianfan.send.result' },
      );
    }
  }
});
