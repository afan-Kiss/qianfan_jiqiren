const fs = require('fs');
const path = require('path');
const dataStore = require('../qianfan-data-store');
const { ok, fail } = require('./adapter-result');
const { wechatReplyContentKey } = require('../runtime/idempotency-keys');
const { resolveDataDir, resolveLogsDir } = require('../shared/app-root');

const DATA_DIR = resolveDataDir();
const IDEMPOTENCY_FILE = path.join(DATA_DIR, 'persist-idempotency.json');
const FAILURE_RECEIPT_FILE = path.join(DATA_DIR, 'failure-receipt-sent.json');
const DEAD_LETTER_FILE = path.join(DATA_DIR, 'dead-letters.json');
const QIANFAN_SEND_PENDING_FILE = path.join(DATA_DIR, 'qianfan-send-pending.json');
const WECHAT_REPLY_DEDUP_FILE = path.join(DATA_DIR, 'wechat-reply-dedup.json');
const BUYER_NOTIFY_CLAIM_FILE = path.join(DATA_DIR, 'buyer-notify-claims.json');
const BUYER_NOTIFY_CLAIM_TTL_MS = 120000;
const MAX_IDEMPOTENCY = 50000;
const MAX_DEAD_LETTERS = 5000;
const QIANFAN_SEND_PENDING_STALE_MS = 120000;
const FAILURE_RECEIPT_STALE_SENDING_MS = 30000;
const QIANFAN_SEND_MAX_ATTEMPTS = 5;
const QIANFAN_SEND_SENDING_STALE_MS = 2 * 60 * 1000;
const QIANFAN_SEND_RETRY_BACKOFF_MS = [5000, 30000, 120000, 600000];

const REQUIRED_ACTIONS = [
  'buyerMessage.ensureDedup',
  'buyerMessage.markNotified',
  'buyerMessage.markPartial',
  'buyerMessage.releaseClaim',
  'notification.recordSuccess',
  'notification.recordFailure',
  'wechatReply.ensureDedup',
  'wechatReply.markHandled',
  'pendingReply.save',
  'pendingReply.resolve',
  'pendingReply.get',
  'sentReply.recordSuccess',
  'sentReply.recordFailure',
  'sessionContext.save',
  'sessionContext.get',
  'qianfanSend.recordPending',
  'qianfanSend.recordSuccess',
  'qianfanSend.recordFailure',
  'qianfanSend.listDue',
  'qianfanSend.markSending',
  'qianfanSend.checkConflict',
  'deadLetter.record',
  'failureReceipt.ensureNotSent',
  'failureReceipt.markSent',
  'failureReceipt.markFailed',
];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  ensureDataDir();
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDataDir();
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const dir = path.dirname(file);
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${attempt}.tmp`);
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      if (process.platform === 'win32') {
        fs.copyFileSync(tmp, file);
        fs.unlinkSync(tmp);
      } else {
        fs.renameSync(tmp, file);
      }
      return;
    } catch (err) {
      lastErr = err;
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        // ignore tmp cleanup errors
      }
    }
  }
  throw lastErr || new Error(`writeJson failed: ${file}`);
}

function loadBuyerNotifyClaimMap() {
  return readJson(BUYER_NOTIFY_CLAIM_FILE, {});
}

function saveBuyerNotifyClaimMap(map) {
  writeJson(BUYER_NOTIFY_CLAIM_FILE, trimObjectKeys(map, 20000));
}

function claimBuyerMessageNotify(message) {
  const key = dataStore.buildCanonicalBuyerMessageKey(message);
  if (!key) return { duplicate: false, claimed: true, notifyKey: '' };
  if (dataStore.hasNotifiedPersisted(message)) {
    return { duplicate: true, notifyKey: key };
  }
  const map = loadBuyerNotifyClaimMap();
  const now = Date.now();
  const existing = map[key];
  if (existing?.status === 'notified') {
    return { duplicate: true, notifyKey: key };
  }
  if (existing?.status === 'partial') {
    map[key] = { status: 'claimed', at: now };
    saveBuyerNotifyClaimMap(map);
    return { duplicate: false, claimed: true, notifyKey: key, resumed: true };
  }
  if (existing?.status === 'claimed' && now - Number(existing.at || 0) < BUYER_NOTIFY_CLAIM_TTL_MS) {
    return { duplicate: true, notifyKey: key, inFlight: true };
  }
  map[key] = { status: 'claimed', at: now };
  saveBuyerNotifyClaimMap(map);
  return { duplicate: false, claimed: true, notifyKey: key };
}

function markBuyerMessageNotifyClaimed(message) {
  const key = dataStore.buildCanonicalBuyerMessageKey(message);
  if (!key) return;
  const map = loadBuyerNotifyClaimMap();
  map[key] = { status: 'notified', at: Date.now() };
  saveBuyerNotifyClaimMap(map);
}

function markBuyerMessageNotifyPartial(message) {
  const key = dataStore.buildCanonicalBuyerMessageKey(message);
  if (!key) return { marked: false, notifyKey: '' };
  const map = loadBuyerNotifyClaimMap();
  map[key] = { status: 'partial', at: Date.now() };
  saveBuyerNotifyClaimMap(map);
  return { marked: true, notifyKey: key };
}

function releaseBuyerMessageNotifyClaim(message) {
  const key = dataStore.buildCanonicalBuyerMessageKey(message);
  if (!key) return { released: false, notifyKey: '' };
  const map = loadBuyerNotifyClaimMap();
  const existing = map[key];
  if (existing?.status !== 'claimed') {
    return { released: false, notifyKey: key, status: existing?.status || 'none' };
  }
  delete map[key];
  saveBuyerNotifyClaimMap(map);
  return { released: true, notifyKey: key };
}

function trimObjectKeys(obj, max) {
  const entries = Object.entries(obj || {});
  if (entries.length <= max) return obj;
  entries.sort((a, b) => Number(a[1]?.at || a[1]?.createdAt || 0) - Number(b[1]?.at || b[1]?.createdAt || 0));
  return Object.fromEntries(entries.slice(entries.length - max));
}

function getIdempotencyStore() {
  return readJson(IDEMPOTENCY_FILE, {});
}

function saveIdempotencyResult(idempotencyKey, data) {
  if (!idempotencyKey) return;
  const store = trimObjectKeys(getIdempotencyStore(), MAX_IDEMPOTENCY);
  store[idempotencyKey] = { data, at: Date.now() };
  writeJson(IDEMPOTENCY_FILE, store);
}

function getCachedIdempotency(idempotencyKey) {
  if (!idempotencyKey) return null;
  const store = getIdempotencyStore();
  return store[idempotencyKey]?.data || null;
}

function appendDeadLetterLog(entry) {
  const logsDir = resolveLogsDir();
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const file = path.join(logsDir, `dead-letter-${y}-${m}-${day}.log`);
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

function checkWechatReplyDuplicate({ wechatReplyMsgId, replyId, fromWxid, text }) {
  return dataStore.isDuplicateWechatReply({ wechatReplyMsgId, replyId, fromWxid, text });
}

function loadFailureReceiptMap() {
  return readJson(FAILURE_RECEIPT_FILE, {});
}

function saveFailureReceiptMap(map) {
  writeJson(FAILURE_RECEIPT_FILE, trimObjectKeys(map, 10000));
}

function loadQianfanSendPendingMap() {
  return readJson(QIANFAN_SEND_PENDING_FILE, {});
}

function saveQianfanSendPendingMap(map) {
  writeJson(QIANFAN_SEND_PENDING_FILE, trimObjectKeys(map, 5000));
}

function normalizeSendAttempts(entry = {}) {
  return Number(entry.attempts ?? entry.retryCount ?? 0);
}

function computeRetryAtAfterFailure(attempts) {
  const idx = Math.min(Math.max(Number(attempts) || 1, 1), QIANFAN_SEND_RETRY_BACKOFF_MS.length) - 1;
  return Date.now() + QIANFAN_SEND_RETRY_BACKOFF_MS[idx];
}

function isQianfanSendDue(entry, now = Date.now()) {
  if (!entry || entry.status === 'sent') return false;
  const attempts = normalizeSendAttempts(entry);
  if (attempts >= QIANFAN_SEND_MAX_ATTEMPTS) return false;

  if (entry.status === 'sending') {
    const sendingAt = Number(entry.sendingAt || 0);
    return sendingAt > 0 && now - sendingAt >= QIANFAN_SEND_SENDING_STALE_MS;
  }

  if (!['pending', 'failed'].includes(entry.status)) return false;

  const hasRetryAt = entry.retryAt !== undefined && entry.retryAt !== null;
  if (!hasRetryAt) {
    return false;
  }

  const retryAt = Number(entry.retryAt);
  if (retryAt > now) return false;

  if (attempts > 0) return true;
  return hasRetryAt;
}

function loadWechatReplyDedupMap() {
  return readJson(WECHAT_REPLY_DEDUP_FILE, {});
}

function saveWechatReplyDedupMap(map) {
  writeJson(WECHAT_REPLY_DEDUP_FILE, trimObjectKeys(map, 10000));
}

const SERIALIZED_ACTIONS = new Set([
  'buyerMessage.ensureDedup',
  'buyerMessage.markNotified',
  'buyerMessage.releaseClaim',
  'wechatReply.ensureDedup',
  'wechatReply.markHandled',
  'qianfanSend.recordPending',
  'qianfanSend.listDue',
  'qianfanSend.markSending',
  'qianfanSend.checkConflict',
  'failureReceipt.ensureNotSent',
  'pendingReply.save',
]);

let persistQueue = Promise.resolve();

async function runSerialized(action, fn) {
  if (!SERIALIZED_ACTIONS.has(action)) return fn();
  const job = persistQueue.then(fn, fn);
  persistQueue = job.catch(() => {});
  return job;
}

async function executeAction(action, data = {}) {
  switch (action) {
    case 'buyerMessage.ensureDedup': {
      const message = data.message || data;
      const mode = data.mode === 'check' ? 'check' : 'claim';
      const key = dataStore.buildCanonicalBuyerMessageKey(message);
      if (dataStore.hasNotifiedPersisted(message)) {
        return ok({ duplicate: true, notifyKey: key });
      }
      if (mode === 'check') {
        const map = loadBuyerNotifyClaimMap();
        const existing = map[key];
        const inFlight =
          existing?.status === 'claimed'
          && Date.now() - Number(existing.at || 0) < BUYER_NOTIFY_CLAIM_TTL_MS;
        const duplicate = existing?.status === 'notified' || inFlight;
        return ok({ duplicate, notifyKey: key, inFlight: Boolean(inFlight), resumed: existing?.status === 'partial' });
      }
      return ok(claimBuyerMessageNotify(message));
    }
    case 'buyerMessage.markPartial': {
      const message = data.message || data;
      return ok(markBuyerMessageNotifyPartial(message));
    }
    case 'buyerMessage.markNotified': {
      const message = data.message || data;
      const notifiedSet = dataStore.loadNotifiedSet();
      dataStore.markNotified(message, notifiedSet);
      markBuyerMessageNotifyClaimed(message);
      return ok({ saved: true, notifyKey: dataStore.buildCanonicalBuyerMessageKey(message) });
    }
    case 'buyerMessage.releaseClaim': {
      const message = data.message || data;
      return ok(releaseBuyerMessageNotifyClaim(message));
    }
    case 'notification.recordSuccess': {
      const entry = data.entry || data;
      let enriched = { ...entry };
      if (enriched.replyId) {
        const pending = dataStore.findPendingByReplyId(enriched.replyId);
        if (pending?.appCid && !enriched.appCid) enriched.appCid = pending.appCid;
        if (pending?.shopTitle && !enriched.shopTitle) enriched.shopTitle = pending.shopTitle;
        if (pending?.buyerNick && !enriched.buyerNick) enriched.buyerNick = pending.buyerNick;
      }
      const wxMsgId = String(enriched.wxMsgId || '').trim()
        || (enriched.replyId ? `reply:${enriched.replyId}:${enriched.targetWxid || 'default'}` : '');
      if (wxMsgId) {
        dataStore.recordSentNotification({ ...enriched, wxMsgId });
      }
      return ok({ saved: true });
    }
    case 'notification.recordFailure': {
      return ok({ saved: true, reason: data.reason || data.error?.message || 'notify_failed' });
    }
    case 'wechatReply.ensureDedup': {
      const wxId = data.wechatReplyMsgId || data.wxMsgId || data.msgId;
      const replyId = data.replyId;
      const contentKey = replyId
        ? wechatReplyContentKey({ replyId, replyText: data.text })
        : '';
      const map = loadWechatReplyDedupMap();
      if (contentKey && map[contentKey]) {
        const age = Date.now() - Number(map[contentKey].at || 0);
        if (age <= QIANFAN_SEND_PENDING_STALE_MS) {
          return ok({ duplicate: true, source: 'persisted-content' });
        }
      }
      if (wxId && map[wxId]) {
        const age = Date.now() - Number(map[wxId].at || 0);
        if (age <= QIANFAN_SEND_PENDING_STALE_MS) {
          return ok({ duplicate: true, source: 'persisted' });
        }
      }
      if (wxId && replyId && map[`${wxId}::${replyId}`]) {
        const age = Date.now() - Number(map[`${wxId}::${replyId}`].at || 0);
        if (age <= QIANFAN_SEND_PENDING_STALE_MS) {
          return ok({ duplicate: true, source: 'persisted' });
        }
      }
      const duplicate = checkWechatReplyDuplicate({
        wechatReplyMsgId: wxId,
        replyId,
        fromWxid: data.fromWxid,
        text: data.text,
      });
      if (duplicate) return ok({ duplicate: true, source: 'memory' });

      const now = Date.now();
      if (contentKey) map[contentKey] = { replyId, wxId, status: 'claimed', at: now };
      if (wxId) {
        map[wxId] = { replyId, at: now };
        if (replyId) map[`${wxId}::${replyId}`] = { replyId, at: now };
      }
      if (contentKey || wxId) saveWechatReplyDedupMap(map);
      return ok({ duplicate: false, claimed: true });
    }
    case 'wechatReply.markHandled': {
      const wxId = data.wechatReplyMsgId || data.wxMsgId || data.msgId;
      const replyId = data.replyId;
      const contentKey = replyId
        ? wechatReplyContentKey({ replyId, replyText: data.text })
        : '';
      dataStore.markWechatReplyProcessed({
        wechatReplyMsgId: wxId,
        replyId,
      });
      const map = loadWechatReplyDedupMap();
      if (contentKey) map[contentKey] = { replyId, at: Date.now() };
      if (wxId) {
        map[wxId] = { replyId, at: Date.now() };
        if (replyId) map[`${wxId}::${replyId}`] = { replyId, at: Date.now() };
      }
      if (contentKey || wxId) saveWechatReplyDedupMap(map);
      return ok({ saved: true });
    }
    case 'pendingReply.save': {
      let record = data.record || data;
      if (!record.replyId && data.allocateReplyId) {
        record = { ...record, replyId: dataStore.nextReplyId() };
      }
      if (record.status !== 'allocating') {
        dataStore.appendPending(record);
      }
      return ok({ saved: true, replyId: record.replyId });
    }
    case 'pendingReply.get': {
      const pending = dataStore.findPendingByReplyId(data.replyId);
      return ok({ pending });
    }
    case 'pendingReply.findOpenForBuyer': {
      const message = data.message || data;
      const pending = dataStore.findOpenPendingForBuyer(message);
      return ok({ pending });
    }
    case 'pendingReply.resolve': {
      if (data.replyId) dataStore.updatePendingAfterReply(data.replyId);
      return ok({ resolved: true });
    }
    case 'sentReply.recordSuccess': {
      dataStore.appendSentReply({
        replyId: data.replyId,
        wechatReplyMsgId: data.wechatReplyMsgId || data.wxMsgId,
        qianfanMsgId: data.qianfanMsgId,
        text: data.text || data.replyText,
        sentAt: data.sentAt || Date.now(),
        status: 'sent',
        ackConfirmed: data.ackConfirmed !== false,
        echoVerified: data.echoVerified === true,
      });
      return ok({ saved: true });
    }
    case 'sentReply.recordFailure': {
      dataStore.appendSentReply({
        replyId: data.replyId,
        wechatReplyMsgId: data.wechatReplyMsgId || data.wxMsgId,
        qianfanMsgId: '',
        text: data.text || data.replyText,
        sentAt: data.sentAt || Date.now(),
        status: 'failed',
        ackConfirmed: false,
      });
      return ok({ saved: true });
    }
    case 'sessionContext.save': {
      const message = data.message || data;
      const ctx = dataStore.saveSessionContext(message);
      return ok({ saved: true, context: ctx });
    }
    case 'sessionContext.get': {
      const ctx = dataStore.getSessionContext(data.shopTitle, data.appCid);
      return ok({ context: ctx });
    }
    case 'qianfanSend.recordPending': {
      const map = loadQianfanSendPendingMap();
      const key = data.idempotencyKey || `${data.replyId}:${data.contentHash || ''}`;
      const existing = map[key];
      const now = Date.now();

      if (existing?.status === 'sent') {
        return ok({
          saved: false,
          alreadyExists: true,
          duplicate: true,
          pendingKey: key,
          status: 'sent',
        });
      }

      if (existing?.status === 'sending') {
        const sendingAt = Number(existing.sendingAt || existing.createdAt || 0);
        if (now - sendingAt <= QIANFAN_SEND_SENDING_STALE_MS) {
          return ok({
            saved: false,
            alreadyExists: true,
            duplicate: true,
            pendingKey: key,
            status: 'sending',
          });
        }
      }

      if (existing && existing.status === 'pending') {
        const age = now - (existing.createdAt || 0);
        if (age <= QIANFAN_SEND_PENDING_STALE_MS) {
          return ok({
            saved: false,
            alreadyExists: true,
            duplicate: true,
            pendingKey: key,
            status: existing.status,
          });
        }
      } else if (
        existing
        && existing.status !== 'failed'
        && normalizeSendAttempts(existing) < QIANFAN_SEND_MAX_ATTEMPTS
      ) {
        return ok({
          saved: false,
          alreadyExists: true,
          duplicate: true,
          pendingKey: key,
          status: existing.status || 'pending',
        });
      }

      map[key] = {
        replyId: data.replyId,
        replyText: data.replyText,
        wxMsgId: data.wxMsgId,
        fromWxid: data.fromWxid,
        traceId: data.traceId,
        pending: data.pending || existing?.pending || null,
        receiverAppUids: Array.isArray(data.receiverAppUids)
          ? data.receiverAppUids.filter(Boolean)
          : (existing?.receiverAppUids || []),
        idempotencyKey: key,
        status: 'pending',
        createdAt: existing?.createdAt || now,
        attempts: existing ? normalizeSendAttempts(existing) : 0,
        retryCount: existing ? normalizeSendAttempts(existing) : 0,
        retryAt: existing?.retryAt,
      };
      saveQianfanSendPendingMap(map);
      return ok({
        saved: true,
        created: true,
        retry: Boolean(existing),
        pendingKey: key,
      });
    }
    case 'qianfanSend.listDue': {
      const map = loadQianfanSendPendingMap();
      const now = Date.now();
      const due = [];
      for (const [pendingKey, entry] of Object.entries(map)) {
        if (!isQianfanSendDue(entry, now)) continue;
        due.push({
          pendingKey,
          ...entry,
          attempts: normalizeSendAttempts(entry),
        });
      }
      due.sort(
        (a, b) => Number(a.retryAt || a.createdAt || 0) - Number(b.retryAt || b.createdAt || 0),
      );
      return ok({ due, count: due.length });
    }
    case 'qianfanSend.markSending': {
      const map = loadQianfanSendPendingMap();
      const key = data.pendingKey || data.idempotencyKey;
      const entry = map[key];
      if (!entry) {
        return ok({ claimed: false, reason: 'missing' });
      }
      const attempts = normalizeSendAttempts(entry);
      if (entry.status === 'sent') {
        return ok({ claimed: false, reason: 'already_sent', pendingKey: key });
      }
      if (attempts >= QIANFAN_SEND_MAX_ATTEMPTS) {
        return ok({ claimed: false, reason: 'max_attempts', pendingKey: key });
      }
      if (entry.status === 'sending') {
        const sendingAt = Number(entry.sendingAt || 0);
        if (sendingAt > 0 && Date.now() - sendingAt < QIANFAN_SEND_SENDING_STALE_MS) {
          return ok({ claimed: false, reason: 'sending_in_flight', pendingKey: key });
        }
      }
      const retryAt = Number(entry.retryAt || 0);
      if (retryAt > Date.now()) {
        return ok({ claimed: false, reason: 'not_due', pendingKey: key });
      }
      for (const [otherKey, other] of Object.entries(map)) {
        if (otherKey === key) continue;
        if (Number(other.replyId) !== Number(entry.replyId)) continue;
        if (other.status !== 'sending') continue;
        const otherSendingAt = Number(other.sendingAt || 0);
        if (otherSendingAt > 0 && Date.now() - otherSendingAt < QIANFAN_SEND_SENDING_STALE_MS) {
          return ok({ claimed: false, reason: 'reply_id_in_flight', pendingKey: key });
        }
      }
      entry.status = 'sending';
      entry.sendingAt = Date.now();
      map[key] = entry;
      saveQianfanSendPendingMap(map);
      return ok({
        claimed: true,
        pendingKey: key,
        entry: { ...entry, pendingKey: key, attempts },
      });
    }
    case 'qianfanSend.checkConflict': {
      const replyId = Number(data.replyId);
      const pendingKey = data.pendingKey || data.idempotencyKey || '';
      const map = loadQianfanSendPendingMap();
      const pendingEntry = pendingKey ? map[pendingKey] : null;
      const sentRecord = dataStore.loadSentReplies().find(
        (row) => Number(row.replyId) === replyId && row.status === 'sent',
      );
      if (!sentRecord) {
        return ok({ conflict: false, replyId, pendingKey });
      }
      if (pendingEntry?.status === 'sent') {
        return ok({ conflict: false, replyId, pendingKey, synced: true });
      }
      return ok({
        conflict: true,
        replyId,
        pendingKey,
        pendingStatus: pendingEntry?.status || 'missing',
        sentRecord,
        message:
          `replyId #${replyId} 已在 qianfan-sent-replies 标记 sent`
          + `（qianfanMsgId=${sentRecord.qianfanMsgId || '无'}），`
          + `但 qianfan-send-pending 仍为 ${pendingEntry?.status || 'missing'}，跳过自动重试`,
      });
    }
    case 'qianfanSend.recordSuccess': {
      const map = loadQianfanSendPendingMap();
      const key = data.idempotencyKey || `${data.replyId}:${data.contentHash || ''}`;
      const qianfanMsgId = String(data.qianfanMsgId || '').trim();
      if (!qianfanMsgId) {
        return fail(new Error('缺少 qianfanMsgId，不能标记 sent'), 'MISSING_QIANFAN_MSG_ID');
      }
      if (map[key]) {
        map[key].status = 'sent';
        map[key].sentAt = Date.now();
        map[key].qianfanMsgId = qianfanMsgId;
        map[key].sendingAt = undefined;
        map[key].lastError = '';
        saveQianfanSendPendingMap(map);
      }
      return ok({ saved: true, pendingKey: key, qianfanMsgId });
    }
    case 'qianfanSend.recordFailure': {
      const map = loadQianfanSendPendingMap();
      const key = data.idempotencyKey || `${data.replyId}:${data.contentHash || ''}`;
      const replyId = data.replyId;
      const wxMsgId = data.wxMsgId || map[key]?.wxMsgId;
      const now = Date.now();
      const entry = map[key] || {
        replyId,
        replyText: data.replyText,
        wxMsgId,
        status: 'pending',
        createdAt: now,
        attempts: 0,
      };
      const attempts = normalizeSendAttempts(entry) + 1;
      entry.attempts = attempts;
      entry.retryCount = attempts;
      entry.lastError = data.reason || data.error?.message || 'send_failed';
      entry.lastTriedAt = now;
      entry.sendingAt = undefined;

      const finalFailure = attempts >= QIANFAN_SEND_MAX_ATTEMPTS;
      if (finalFailure) {
        entry.status = 'failed';
        entry.failedAt = now;
        entry.reason = entry.lastError;
        entry.retryAt = undefined;
        entry.finalFailure = true;
      } else {
        entry.status = 'pending';
        entry.retryAt = computeRetryAtAfterFailure(attempts);
        entry.finalFailure = false;
      }

      map[key] = entry;
      saveQianfanSendPendingMap(map);

      const replyText = data.replyText;
      const dedupMap = loadWechatReplyDedupMap();
      let dedupChanged = false;
      if (finalFailure && replyId && replyText) {
        const contentKey = wechatReplyContentKey({ replyId, replyText });
        if (contentKey && dedupMap[contentKey]) {
          delete dedupMap[contentKey];
          dedupChanged = true;
        }
      }
      if (finalFailure && wxMsgId) {
        if (dedupMap[wxMsgId]) {
          delete dedupMap[wxMsgId];
          dedupChanged = true;
        }
        if (replyId && dedupMap[`${wxMsgId}::${replyId}`]) {
          delete dedupMap[`${wxMsgId}::${replyId}`];
          dedupChanged = true;
        }
      }
      if (dedupChanged) saveWechatReplyDedupMap(dedupMap);
      if (finalFailure && wxMsgId) {
        dataStore.unmarkWechatReplyProcessed({ wechatReplyMsgId: wxMsgId, replyId });
      }
      return ok({
        saved: true,
        reason: entry.lastError,
        attempts,
        finalFailure,
        retryAt: entry.retryAt,
        pendingKey: key,
      });
    }
    case 'failureReceipt.ensureNotSent': {
      const key = data.key || data.idempotencyKey;
      const map = loadFailureReceiptMap();
      const entry = map[key];
      if (entry?.status === 'sent') {
        return ok({
          alreadySent: true,
          duplicate: true,
          inFlight: false,
          entry: entry || null,
        });
      }
      if (entry?.status === 'sending') {
        const age = Date.now() - (entry.claimedAt || 0);
        if (age < FAILURE_RECEIPT_STALE_SENDING_MS) {
          return ok({
            alreadySent: false,
            duplicate: true,
            inFlight: true,
            entry: entry || null,
          });
        }
      }
      map[key] = {
        status: 'sending',
        replyId: data.replyId,
        receiverWxid: data.receiverWxid,
        errorCodeOrType: data.errorCodeOrType || 'unknown',
        claimedAt: Date.now(),
      };
      saveFailureReceiptMap(map);
      return ok({ alreadySent: false, created: true, entry: map[key] });
    }
    case 'failureReceipt.markSent': {
      const key = data.key || data.idempotencyKey;
      const map = loadFailureReceiptMap();
      map[key] = {
        status: 'sent',
        replyId: data.replyId,
        receiverWxid: data.receiverWxid,
        sentAt: Date.now(),
      };
      saveFailureReceiptMap(map);
      return ok({ saved: true });
    }
    case 'failureReceipt.markFailed': {
      const key = data.key || data.idempotencyKey;
      const map = loadFailureReceiptMap();
      map[key] = {
        status: 'failed',
        replyId: data.replyId,
        receiverWxid: data.receiverWxid,
        reason: data.reason || data.error?.message || 'send_failed',
        failedAt: Date.now(),
      };
      saveFailureReceiptMap(map);
      return ok({ saved: true });
    }
    case 'deadLetter.record': {
      const entry = {
        traceId: data.traceId,
        topic: data.topic,
        workerName: data.workerName || data.sourceWorker,
        reason: data.reason,
        payload: data.payload,
        error: data.error,
        createdAt: data.createdAt || Date.now(),
      };
      const list = readJson(DEAD_LETTER_FILE, []);
      list.push(entry);
      const trimmed = list.length > MAX_DEAD_LETTERS ? list.slice(list.length - MAX_DEAD_LETTERS) : list;
      writeJson(DEAD_LETTER_FILE, trimmed);
      appendDeadLetterLog(entry);
      return ok({ saved: true, id: trimmed.length });
    }
    case 'nextReplyId':
      return ok({ replyId: dataStore.nextReplyId() });
    case 'markNotified':
      dataStore.markNotified(data.message || data, dataStore.loadNotifiedSet());
      return ok({ saved: true });
    case 'appendPending':
      dataStore.appendPending(data.record || data);
      return ok({ saved: true });
    case 'recordSentNotification':
      dataStore.recordSentNotification(data.entry || data);
      return ok({ saved: true });
    case 'saveSessionContext':
      return ok({ saved: true, context: dataStore.saveSessionContext(data.message || data) });
    case 'findPendingByReplyId':
      return ok({ pending: dataStore.findPendingByReplyId(data.replyId) });
    default:
      return fail(new Error(`未知 persist action: ${action}`), 'UNKNOWN_ACTION');
  }
}

const NO_IDEMPOTENCY_CACHE_ACTIONS = new Set([
  'buyerMessage.ensureDedup',
  'wechatReply.ensureDedup',
  'failureReceipt.ensureNotSent',
  'qianfanSend.recordPending',
  'qianfanSend.listDue',
  'qianfanSend.markSending',
  'qianfanSend.checkConflict',
  'pendingReply.get',
  'pendingReply.save',
  'pendingReply.resolve',
  'sessionContext.get',
]);

async function handlePersistRequest(payload = {}) {
  try {
    const { action, data, idempotencyKey } = payload;
    if (!action) return fail(new Error('缺少 action'), 'MISSING_ACTION');

    if (!NO_IDEMPOTENCY_CACHE_ACTIONS.has(action)) {
      const cached = getCachedIdempotency(idempotencyKey);
      if (cached) {
        return ok({ ...cached, idempotent: true });
      }
    }

    const result = await runSerialized(action, () => executeAction(action, data || {}));
    if (result.ok && idempotencyKey && !NO_IDEMPOTENCY_CACHE_ACTIONS.has(action)) {
      saveIdempotencyResult(idempotencyKey, result.data);
    }
    return result;
  } catch (err) {
    return fail(err, 'PERSIST_FAILED');
  }
}

module.exports = {
  REQUIRED_ACTIONS,
  handlePersistRequest,
  executeAction,
};
