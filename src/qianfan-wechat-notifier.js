/**
 * 千帆买家消息 → 微信通知（仅通知，不回复）
 */
const fs = require('fs');
const path = require('path');
const config = require('./wechat/wxbot-new-config');
const { getLiveNotifyTargets } = config;
const { println } = require('./utils');
const { formatWechatSendConsoleLine } = require('./wxbot-new-callback-log');
const {
  nextReplyId,
  loadNotifiedSet,
  markNotified,
  appendPending,
  hasNotified,
  buildCanonicalBuyerMessageKey,
  normalizeMessageText,
  recordSentNotification,
  saveSessionContext,
  extractReceiverAppUidsFromMessage,
  findOpenPendingForBuyer,
} = require('./qianfan-data-store');
const { sendWxText, sendWxBuyerImages } = require('./wechat-send-api');
const { collectMessageImageUrls } = require('./chat-parse');

const MERGE_MS = process.env.QIANFAN_SIM_MERGE_MS != null
  ? Number(process.env.QIANFAN_SIM_MERGE_MS)
  : Number(config.oneClick?.mergeWindowMs || 3000);
const QUEUE_SEEN_KEYS_MAX = 10000;
const NOTIFY_TARGET_RETRY_DELAY_MS = 2000;
const NOTIFY_TARGET_RETRY_ROUNDS = 2;
const notifiedSet = loadNotifiedSet();
const mergeBuckets = new Map();
const queueSeenKeys = new Set();
let releaseSeenBuyerMessageFn = null;

function debugLog(entry) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const dir = path.join(config.root, 'logs', 'debug');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `qianfan-to-wechat-${y}-${m}-${day}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify({ time: d.toISOString(), ...entry })}\n`, 'utf8');
}

function duplicateDebugLog(entry) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const dir = path.join(config.root, 'logs', 'debug');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `qianfan-duplicate-debug-${y}-${m}-${day}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify({ time: d.toISOString(), ...entry })}\n`, 'utf8');
}

function formatTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function getNotifyTargets() {
  const targets = getLiveNotifyTargets();
  return targets.length
    ? targets
    : [
        {
          name: '二号',
          wechatNo: config.notifyReceiverAccount.wechatNo,
          wxid: config.notifyReceiverAccount.wxid,
        },
      ];
}

function formatTargetLabel(target) {
  return `${target.name} ${target.wechatNo} ${target.wxid}`;
}

const NOTICE_DASH = '┈';
const NOTICE_WIDTH = 20;

function noticeDashedLine(label = '') {
  const text = String(label || '').trim();
  if (!text) return NOTICE_DASH.repeat(NOTICE_WIDTH);
  const gap = Math.max(0, NOTICE_WIDTH - text.length - 2);
  const left = Math.floor(gap / 2);
  const right = gap - left;
  return `${NOTICE_DASH.repeat(left)} ${text} ${NOTICE_DASH.repeat(right)}`;
}

function formatWechatNotice(replyId, merged) {
  const uniqueTexts = [];
  const seen = new Set();
  for (const t of merged.texts) {
    const block = String(t || '').trim();
    if (!block || seen.has(block)) continue;
    seen.add(block);
    uniqueTexts.push(block);
  }

  const body = [
    noticeDashedLine(),
    `【千帆待回复 #${replyId}】`,
    '',
    `店铺  ${merged.shopTitle}`,
    `买家  ${merged.buyerNick || '买家'}`,
    `时间  ${formatTime(merged.createAt)}`,
    '',
    '消息',
  ];

  if (uniqueTexts.length === 1) {
    body.push(uniqueTexts[0]);
  } else {
    uniqueTexts.forEach((t, i) => body.push(`${i + 1}. ${t}`));
  }

  body.push(
    '',
    noticeDashedLine('引用本消息回复'),
    noticeDashedLine(),
  );

  return body.join('\n');
}

function isPendingInMergeBucket(message) {
  const bucketKey = `${message.shopTitle}::${message.appCid}`;
  const bucket = mergeBuckets.get(bucketKey);
  if (!bucket) return false;
  return bucket.seenMessageKeys.has(buildCanonicalBuyerMessageKey(message));
}

function logNotifyCheck(message, dedupKey, extra = {}) {
  println(
    `[诊断] notify-check msgId=${message.msgId || ''} dedupKey=${dedupKey} alreadyNotified=${extra.alreadyNotified ? 'true' : 'false'} queueSeen=${extra.queueSeen ? 'true' : 'false'} pendingExists=${extra.pendingExists ? 'true' : 'false'}`
  );
}

function logNotifySkip(message, reason) {
  println(`[诊断] notify-skip msgId=${message.msgId || ''} reason=${reason}`);
}

function logNotifySendStart(replyId, message) {
  println(`[诊断] notify-send-start replyId=#${replyId} msgId=${message.msgId || ''}`);
}

function logNotifySendOk(replyId, message, options = {}) {
  if (options.httpFallback) {
    println(`[兜底] 已补发微信通知 #${replyId} msgId=${message.msgId || ''}`);
  }
  println(`[诊断] notify-send-ok replyId=#${replyId} msgId=${message.msgId || ''}`);
}

function trimQueueSeenKeys() {
  if (queueSeenKeys.size <= QUEUE_SEEN_KEYS_MAX) return;
  const keys = [...queueSeenKeys];
  const keep = keys.slice(keys.length - QUEUE_SEEN_KEYS_MAX);
  queueSeenKeys.clear();
  for (const k of keep) queueSeenKeys.add(k);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logDuplicateIgnored(message, canonicalKey, where) {
  const preview = normalizeMessageText(message.text) || message.text || '';
  duplicateDebugLog({
    event: 'duplicate_ignored',
    where,
    source: message.source || 'unknown',
    canonicalKey,
    shopTitle: message.shopTitle,
    appCid: message.appCid,
    msgId: message.msgId || '',
    text: preview,
    createAt: message.createAt,
  });
  println(`[忽略] 重复买家消息：${preview}`);
}

async function forwardBucketImages(replyId, bucket, targets) {
  const mediaMessages = bucket.messages.filter((m) => collectMessageImageUrls(m).length > 0);
  if (!mediaMessages.length) return;

  for (const target of targets) {
    for (const msg of mediaMessages) {
      const urls = collectMessageImageUrls(msg);
      if (!urls.length) continue;

      try {
        if (config.dryRun) {
          println(`[微信] #${replyId} [DRY_RUN] 将发送图片给 ${formatTargetLabel(target)}`);
          continue;
        }
        const result = await sendWxBuyerImages(target.wxid, {
          imageUrls: urls,
          msgId: msg.msgId,
          replyId,
        });
        if (result.sent > 0) {
          println(`[微信] 已发送图片给二号：#${replyId}`);
          continue;
        }
        if (result.usedLink) {
          println(`[微信] 图片未能直发，已发送链接给二号：#${replyId}`);
          continue;
        }
        throw result.error || new Error('图片发送失败');
      } catch (err) {
        println(`[错误] 图片转发失败 #${replyId}：${err.message || err}`);
        try {
          await sendWxText(target.wxid, '⚠️ 图片转发失败，请到千帆查看原图');
        } catch {
          // ignore
        }
      }
    }
  }
}

function resolveBucketWaiters(bucket, outcome) {
  const waiters = bucket._flushWaiters || [];
  bucket._flushWaiters = [];
  for (const waiter of waiters) {
    waiter.resolve(outcome);
  }
}

async function releaseBucketNotifyClaims(bucket, hooks) {
  for (const msg of bucket?.messages || []) {
    if (hooks?.releaseNotifyClaim) {
      await hooks.releaseNotifyClaim(msg);
    }
  }
}

async function markBucketNotifyPartial(bucket, hooks) {
  for (const msg of bucket?.messages || []) {
    if (hooks?.markPartialNotifyClaim) {
      await hooks.markPartialNotifyClaim(msg);
    }
  }
}

function clearBucketQueueSeen(bucket) {
  for (const msg of bucket?.messages || []) {
    const canonicalKey = buildCanonicalBuyerMessageKey(msg);
    queueSeenKeys.delete(canonicalKey);
    if (releaseSeenBuyerMessageFn) releaseSeenBuyerMessageFn(msg);
  }
}

async function cleanupFailedBucket(bucket, hooks) {
  clearBucketQueueSeen(bucket);
  await releaseBucketNotifyClaims(bucket, hooks);
}

async function flushMergeBucket(bucketKey) {
  const bucket = mergeBuckets.get(bucketKey);
  if (!bucket) return { ok: false, skipped: true, reason: 'bucket_missing' };
  mergeBuckets.delete(bucketKey);
  clearTimeout(bucket.timer);

  try {
  const hooks = bucket.persistHooks || null;
  const primaryMsg = bucket.messages[bucket.messages.length - 1];
  let resumePending = null;
  if (hooks?.findOpenPendingForBuyer && primaryMsg) {
    resumePending = await hooks.findOpenPendingForBuyer(primaryMsg);
  } else if (primaryMsg) {
    resumePending = findOpenPendingForBuyer(primaryMsg);
  }

  let replyId;
  if (resumePending?.replyId) {
    replyId = Number(resumePending.replyId);
    println(`[通知] 续发 #${replyId}，补发给尚未成功的通知人`);
  } else if (hooks?.nextReplyId) {
    const allocated = await hooks.nextReplyId();
    replyId = Number(allocated?.replyId ?? allocated ?? nextReplyId());
  } else {
    replyId = nextReplyId();
  }
  const targets = getNotifyTargets();
  const content = formatWechatNotice(replyId, bucket);
  const alreadySentWxids = new Set(
    Array.isArray(resumePending?.wechatTargets)
      ? resumePending.wechatTargets.map((x) => String(x || '').trim()).filter(Boolean)
      : [],
  );
  const wxids = [...alreadySentWxids];
  const receiverAppUids = [
    ...new Set(
      bucket.messages.flatMap((m) => extractReceiverAppUidsFromMessage(m)).filter(Boolean)
    ),
  ];

  async function saveCtx(msg) {
    if (hooks?.saveSessionContext) return hooks.saveSessionContext(msg);
    return saveSessionContext(msg);
  }

  async function savePending(record) {
    if (hooks?.appendPending) {
      await hooks.appendPending(record);
      if (process.env.QIANFAN_SIM_MODE === '1') appendPending(record);
      return;
    }
    appendPending(record);
  }

  async function markNotifiedMsg(msg) {
    if (hooks?.markNotified) return hooks.markNotified(msg);
    markNotified(msg, notifiedSet);
  }

  async function recordSent(entry) {
    if (hooks?.recordSentNotification) return hooks.recordSentNotification(entry);
    recordSentNotification(entry);
  }

  for (const msg of bucket.messages) {
    await saveCtx(msg);
  }
  if (receiverAppUids.length && bucket.appCid) {
    const ctx = await saveCtx({
      shopTitle: bucket.shopTitle,
      appCid: bucket.appCid,
      buyerNick: bucket.buyerNick,
      buyerMsgId: bucket.messages[bucket.messages.length - 1]?.msgId,
      senderAppUid: receiverAppUids[0],
      receiverAppUids,
      text: bucket.texts[bucket.texts.length - 1],
      createAt: bucket.createAt,
      source: 'buyer_message_notify',
    });
    if (ctx) {
      println(
        `[千帆] 已缓存会话发送上下文：店铺=${ctx.shopTitle} 买家=${ctx.buyerNick} appCid=${ctx.appCid} receiverAppUids=${JSON.stringify(ctx.receiverAppUids)}`
      );
    }
  }

  await savePending({
    replyId,
    shopTitle: bucket.shopTitle,
    appCid: bucket.appCid,
    buyerNick: bucket.buyerNick,
    buyerMsgId: primaryMsg?.msgId,
    buyerText: primaryMsg?.text,
    contentType: primaryMsg?.contentType || 'text',
    imageUrls: collectMessageImageUrls(primaryMsg).length
      ? collectMessageImageUrls(primaryMsg)
      : undefined,
    productInfo: primaryMsg?.productInfo || undefined,
    orderInfo: primaryMsg?.orderInfo || undefined,
    createdAt: bucket.createAt,
    receiverAppUids,
    wechatTargets: [...wxids],
    status: 'notifying',
  });

  const notifyTargets = [];
  const sentMessages = [];
  let lastWxMsgId = '';

  async function deliverToTarget(target) {
    for (const msg of bucket.messages) {
      logNotifySendStart(replyId, msg);
    }
    if (config.dryRun) {
      println(`[通知] #${replyId} [DRY_RUN] 将发送微信：${formatTargetLabel(target)}`);
      return;
    }
    println(
      formatWechatSendConsoleLine({
        wxid: target.wxid,
        content,
        label: formatTargetLabel(target),
      }),
    );
    const sendResult = await sendWxText(target.wxid, content);
    println(`[通知] #${replyId} 已发送微信：${formatTargetLabel(target)}`);
    for (const msg of bucket.messages) {
      logNotifySendOk(replyId, msg, { httpFallback: bucket.httpFallback });
    }
    if (sendResult.wxMsgId) {
      lastWxMsgId = sendResult.wxMsgId;
      sentMessages.push({ wxid: target.wxid, wxMsgId: sendResult.wxMsgId });
      await recordSent({
        wxMsgId: sendResult.wxMsgId,
        replyId,
        shopTitle: bucket.shopTitle,
        appCid: bucket.appCid,
        buyerNick: bucket.buyerNick,
        sentAt: Date.now(),
        targetWxid: target.wxid,
      });
    }
  }

  let retryTargets = targets.filter((target) => !alreadySentWxids.has(String(target.wxid || '').trim()));
  for (let round = 0; round < NOTIFY_TARGET_RETRY_ROUNDS && retryTargets.length > 0; round += 1) {
    const failed = [];
    for (const target of retryTargets) {
      try {
        await deliverToTarget(target);
        const wxid = String(target.wxid || '').trim();
        if (wxid && !wxids.includes(wxid)) wxids.push(wxid);
        notifyTargets.push(target);
      } catch (err) {
        println(
          `[错误] 微信通知发送失败：${formatTargetLabel(target)}，原因：${err.message || err}`,
        );
        debugLog({ level: 'error', replyId, target: target.wxid, error: String(err.message || err) });
        failed.push(target);
      }
    }
    retryTargets = failed;
    if (retryTargets.length > 0 && round + 1 < NOTIFY_TARGET_RETRY_ROUNDS) {
      println(`[通知] #${replyId} 部分通知人失败，${NOTIFY_TARGET_RETRY_DELAY_MS / 1000}s 后重试`);
      await sleep(NOTIFY_TARGET_RETRY_DELAY_MS);
    }
  }

  for (const target of targets) {
    const wxid = String(target.wxid || '').trim();
    if (alreadySentWxids.has(wxid) && !notifyTargets.some((item) => item.wxid === target.wxid)) {
      notifyTargets.push(target);
    }
  }

  if (notifyTargets.length) {
    await forwardBucketImages(replyId, bucket, notifyTargets);
  }

  const notifyAllOk = targets.length > 0 && targets.every((target) => wxids.includes(target.wxid));
  const notifyOk = wxids.length > 0;
  for (const msg of bucket.messages) {
    const canonicalKey = buildCanonicalBuyerMessageKey(msg);
    queueSeenKeys.delete(canonicalKey);
    if (notifyAllOk) {
      await markNotifiedMsg(msg);
    } else if (releaseSeenBuyerMessageFn) {
      releaseSeenBuyerMessageFn(msg);
    }
    const imageUrls = collectMessageImageUrls(msg);
    await savePending({
      replyId,
      shopTitle: bucket.shopTitle,
      appCid: bucket.appCid,
      buyerNick: bucket.buyerNick,
      buyerMsgId: msg.msgId,
      buyerText: msg.text,
      contentType: msg.contentType || 'text',
      imageUrls: imageUrls.length ? imageUrls : undefined,
      productInfo: msg.productInfo || undefined,
      orderInfo: msg.orderInfo || undefined,
      createdAt: msg.createAt,
      receiverAppUids,
      wechatTargets: wxids,
      status: notifyAllOk ? 'notified' : (notifyOk ? 'notify_partial' : 'notify_failed'),
      notifiedAt: notifyAllOk ? Date.now() : undefined,
    });
  }

  if (!notifyOk) {
    await releaseBucketNotifyClaims(bucket, hooks);
  } else if (!notifyAllOk) {
    await markBucketNotifyPartial(bucket, hooks);
  }

  debugLog({
    level: 'info',
    replyId,
    shopTitle: bucket.shopTitle,
    appCid: bucket.appCid,
    buyerNick: bucket.buyerNick,
    texts: bucket.texts,
    targets: wxids,
  });

  const outcome = {
    ok: notifyOk,
    notifyAllOk,
    replyId,
    targets: wxids,
    sentMessages,
    wxMsgId: lastWxMsgId || undefined,
    reason: notifyOk ? (notifyAllOk ? undefined : 'notify_partial') : 'notify_failed',
  };
  resolveBucketWaiters(bucket, outcome);
  return outcome;
  } catch (err) {
    await cleanupFailedBucket(bucket, bucket.persistHooks || null);
    const outcome = { ok: false, reason: err.message || String(err), error: err };
    resolveBucketWaiters(bucket, outcome);
    return outcome;
  }
}

function queueBuyerNotification(message, options = {}) {
  const canonicalKey = buildCanonicalBuyerMessageKey(message);
  const alreadyNotified = hasNotified(message, notifiedSet);
  const queueSeen = queueSeenKeys.has(canonicalKey);
  const pendingExists = isPendingInMergeBucket(message);

  logNotifyCheck(message, canonicalKey, { alreadyNotified, queueSeen, pendingExists });

  if (alreadyNotified) {
    logNotifySkip(message, 'already_notified');
    return Promise.resolve({ ok: true, skipped: true, reason: 'already_notified' });
  }
  if (queueSeen) {
    logNotifySkip(message, 'appcid_queue_seen');
    logDuplicateIgnored(message, canonicalKey, 'queue');
    return Promise.resolve({ ok: true, skipped: true, reason: 'appcid_queue_seen' });
  }

  const bucketKey = `${message.shopTitle}::${message.appCid}`;
  let bucket = mergeBuckets.get(bucketKey);
  if (!bucket) {
    bucket = {
      shopTitle: message.shopTitle,
      appCid: message.appCid,
      buyerNick: message.buyerNick,
      createAt: message.createAt,
      texts: [],
      messages: [],
      msgIds: [],
      seenMessageKeys: new Set(),
      seenTexts: new Set(),
      httpFallback: options.httpFallback === true,
      persistHooks: options.persistHooks || null,
      timer: null,
    };
    mergeBuckets.set(bucketKey, bucket);
  } else if (options.httpFallback) {
    bucket.httpFallback = true;
  }
  if (options.persistHooks) bucket.persistHooks = options.persistHooks;

  const normalizedText = normalizeMessageText(message.text);
  const dedupeTextKey = message.msgId
    ? `${message.contentType || 'text'}::${message.msgId}`
    : normalizedText || message.contentType || 'unknown';

  if (bucket.seenMessageKeys.has(canonicalKey)) {
    logNotifySkip(message, 'bucket_duplicate_key');
    logDuplicateIgnored(message, canonicalKey, 'bucket_key');
    return Promise.resolve({ ok: true, skipped: true, reason: 'bucket_duplicate_key' });
  }
  if (dedupeTextKey && bucket.seenTexts.has(dedupeTextKey)) {
    logNotifySkip(message, 'bucket_duplicate_text');
    logDuplicateIgnored(message, canonicalKey, 'bucket_text');
    return Promise.resolve({ ok: true, skipped: true, reason: 'bucket_duplicate_text' });
  }

  if (!bucket._flushWaiters) bucket._flushWaiters = [];
  const flushPromise = new Promise((resolve, reject) => {
    bucket._flushWaiters.push({ resolve, reject });
  });

  bucket.seenMessageKeys.add(canonicalKey);
  queueSeenKeys.add(canonicalKey);
  trimQueueSeenKeys();
  if (dedupeTextKey) bucket.seenTexts.add(dedupeTextKey);
  if (message.msgId) bucket.msgIds.push(String(message.msgId));

  bucket.texts.push(message.text);
  bucket.messages.push(message);
  bucket.createAt = message.createAt;
  if (message.buyerNick) bucket.buyerNick = message.buyerNick;

  clearTimeout(bucket.timer);
  if (MERGE_MS <= 0) {
    void flushMergeBucket(bucketKey).catch((err) => {
      println(`[错误] 微信通知失败：${err.message || err}`);
    });
  } else {
    bucket.timer = setTimeout(() => {
      void flushMergeBucket(bucketKey).catch((err) => {
        println(`[错误] 微信通知失败：${err.message || err}`);
      });
    }, MERGE_MS);
  }
  return flushPromise;
}

function createQianfanWechatNotifier(options = {}) {
  const enabled = options.enabled !== false;
  const persistHooks = options.persistHooks || null;
  releaseSeenBuyerMessageFn =
    typeof options.releaseSeenBuyerMessage === 'function' ? options.releaseSeenBuyerMessage : null;

  return {
    handleBuyerMessage(message, options = {}) {
      if (!enabled) return Promise.resolve({ ok: true, skipped: true, reason: 'disabled' });
      return queueBuyerNotification(message, { ...options, persistHooks });
    },
  };
}

module.exports = {
  createQianfanWechatNotifier,
  getNotifyTargets,
  formatWechatNotice,
  buildCanonicalBuyerMessageKey,
};
