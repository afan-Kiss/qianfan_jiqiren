const { createWorkerRuntime } = require('./worker-bootstrap');
const { notifyBuyerMessage, createPersistHooks } = require('../adapters/legacy-wechat-notifier-adapter');
const { buyerMessageKeyFromMessage } = require('../runtime/idempotency-keys');
const {
  formatNotifySuccessMessage,
  formatNotifyPartialMessage,
} = require('../shared/user-activity-log');
const config = require('../wechat/wxbot-new-config');

const runtime = createWorkerRuntime({ workerName: 'wechat-notifier' });

const persistHooks = createPersistHooks(runtime);

function resolveFailedNotifyTargets(sentWxids = []) {
  const sent = new Set(sentWxids.map((x) => String(x || '').trim()).filter(Boolean));
  return config.getLiveNotifyTargets()
    .map((target) => String(target.wxid || '').trim())
    .filter((wxid) => wxid && !sent.has(wxid));
}

async function handleNotify(payload, meta) {
  const message = payload?.message ?? payload;
  const options = payload?.options || {};
  const traceId = meta.traceId || payload.traceId || runtime.newTraceId();
  const idempotencyKey = buyerMessageKeyFromMessage(message);

  const dedupResult = await runtime.persist(
    'buyerMessage.ensureDedup',
    { message },
    { idempotencyKey: `dedup-notify:${idempotencyKey}`, traceId },
  );

  if (!dedupResult.ok) {
    runtime.log('error', `notify dedup persist failed: ${dedupResult.error?.message || 'unknown'}`, {
      traceId,
    });
    runtime.publish(
      'wechat.notify.result',
      {
        success: false,
        reason: 'persist_failed',
        request: payload,
        traceId,
        error: dedupResult.error,
      },
      meta,
    );
    return;
  }

  if (dedupResult.ok && dedupResult.data?.duplicate) {
    runtime.log('info', `notify skipped duplicate buyer message`, { traceId });
    runtime.publish(
      'wechat.notify.result',
      {
        success: true,
        skipped: true,
        reason: 'duplicate',
        request: payload,
        traceId,
      },
      meta,
    );
    return;
  }

  await runtime.persist(
    'sessionContext.save',
    { message },
    { idempotencyKey: `session-notify:${idempotencyKey}`, traceId },
  );

  const result = await notifyBuyerMessage(message, {
    ...options,
    persistHooks,
    onWechatSendError: (err) => runtime.reportWechatSendError(err, { reason: 'notify_send_failed' }),
  });

  if (result.ok && !result.data?.skipped && result.data?.replyId) {
    if (result.data.notifyAllOk) {
      runtime.userLog(
        formatNotifySuccessMessage({
          replyId: result.data.replyId,
          message,
          targets: result.data.targets,
          sentMessages: result.data.sentMessages,
        }),
        { dedupKey: `notify-ok:${result.data.replyId}` },
      );
    } else if (result.data.notifyPartial) {
      runtime.userLog(
        formatNotifyPartialMessage({
          replyId: result.data.replyId,
          message,
          targets: result.data.targets,
          sentMessages: result.data.sentMessages,
          failedTargets: resolveFailedNotifyTargets(result.data.targets),
        }),
        {
          dedupKey: `notify-partial:${result.data.replyId}`,
          level: 'error',
        },
      );
    }
  }

  runtime.publish(
    'wechat.notify.result',
    {
      success: result.ok,
      request: payload,
      result,
      traceId,
      error: result.ok ? undefined : result.error,
    },
    meta,
  );
}

runtime.onTopic('buyer-message.detected', handleNotify);
