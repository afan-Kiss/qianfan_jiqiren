/**
 * 千帆通知编号 / 去重 / pending 持久化
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveDataDir } = require('./shared/app-root');

const DATA_DIR = resolveDataDir();
const PENDING_FILE = path.join(DATA_DIR, 'pending-notifications.json');
const NOTIFIED_FILE = path.join(DATA_DIR, 'notified-message-ids.json');
const REPLY_ID_FILE = path.join(DATA_DIR, 'reply-id-counter.json');
const SENT_MAP_FILE = path.join(DATA_DIR, 'sent-notification-map.json');
const SENT_REPLIES_FILE = path.join(DATA_DIR, 'qianfan-sent-replies.json');
const APP_CID_RECEIVERS_FILE = path.join(DATA_DIR, 'app-cid-receivers.json');
const SESSION_CONTEXT_FILE = path.join(DATA_DIR, 'qianfan-session-context.json');

const MAX_NOTIFIED_KEYS = 20000;
const MAX_PENDING_ENTRIES = 5000;
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SENT_MAP_ENTRIES = 5000;
const MAX_SENT_REPLIES = 5000;
const MAX_PROCESSED_WECHAT_REPLY_KEYS = 10000;

const processedWechatReplyKeys = new Set();
const recentFallbackKeys = new Set();

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

function trimSetTail(set, max) {
  if (set.size <= max) return;
  const keys = [...set];
  const keep = keys.slice(keys.length - max);
  set.clear();
  for (const k of keep) set.add(k);
}

function trimPendingList(list) {
  const cutoff = Date.now() - PENDING_MAX_AGE_MS;
  let trimmed = (Array.isArray(list) ? list : []).filter((p) => {
    const ts = Number(p.createdAt || p.lastReplyAt || 0);
    return !ts || ts >= cutoff;
  });
  if (trimmed.length > MAX_PENDING_ENTRIES) {
    trimmed = trimmed.slice(trimmed.length - MAX_PENDING_ENTRIES);
  }
  return trimmed;
}

function trimSentMap(map) {
  const entries = Object.entries(map || {});
  if (entries.length <= MAX_SENT_MAP_ENTRIES) return map;
  entries.sort((a, b) => Number(a[1]?.sentAt || 0) - Number(b[1]?.sentAt || 0));
  return Object.fromEntries(entries.slice(entries.length - MAX_SENT_MAP_ENTRIES));
}

function nextReplyId() {
  const state = readJson(REPLY_ID_FILE, { nextReplyId: 1001 });
  const id = Number(state.nextReplyId || 1001);
  state.nextReplyId = id + 1;
  writeJson(REPLY_ID_FILE, state);
  return id;
}

function loadNotifiedSet() {
  const raw = readJson(NOTIFIED_FILE, { keys: [] });
  const set = new Set(Array.isArray(raw.keys) ? raw.keys : []);
  trimSetTail(set, MAX_NOTIFIED_KEYS);
  return set;
}

function saveNotifiedSet(set) {
  trimSetTail(set, MAX_NOTIFIED_KEYS);
  writeJson(NOTIFIED_FILE, { keys: [...set] });
}

function normalizeMessageText(text) {
  return String(text || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function contentHashForDedup(message) {
  const parts = [
    normalizeMessageText(message?.text),
    String(message?.contentType || 'text'),
    String(
      (Array.isArray(message?.imageUrls) && message.imageUrls[0]) ||
        message?.thumbUrl ||
        message?.productInfo?.productId ||
        message?.orderInfo?.orderId ||
        ''
    ),
  ].filter(Boolean);
  if (!parts.length) return '0';
  return crypto.createHash('md5').update(parts.join('::')).digest('hex').slice(0, 12);
}

function isLikelyConversationId(id, appCid) {
  const s = String(id || '').trim();
  const cid = String(appCid || '').trim();
  if (!s) return true;
  if (cid && s === cid) return true;
  if (/^[\d.]+$/.test(s) && s.length < 8) return true;
  return false;
}

function extractDedupMsgId(message) {
  const appCid = String(message?.appCid || '').trim();
  const raw = message?.raw && typeof message.raw === 'object' ? message.raw : {};
  const candidates = [
    message?.msgId,
    message?.messageId,
    message?.message_id,
    message?.msg_id,
    message?.clientMsgId,
    message?.localMsgId,
    message?.serverMsgId,
    message?.sMid,
    message?.seqId,
    raw?.msgId,
    raw?.messageId,
    raw?.message_id,
    raw?.clientMsgId,
    raw?.sMid,
    raw?.uuid,
  ];
  for (const value of candidates) {
    const id = String(value || '').trim();
    if (!id || isLikelyConversationId(id, appCid)) continue;
    return id;
  }
  return '';
}

function buildCanonicalBuyerMessageKey(message) {
  const shopTitle = String(message?.shopTitle || '').trim();
  const appCid = String(message?.appCid || '').trim();
  const stableMsgId = extractDedupMsgId(message);
  const contentType = String(message?.contentType || 'text').trim();
  const normalizedText = normalizeMessageText(message?.text);
  const createAt = Number(message?.createAt || 0);
  const senderAppUid = String(message?.senderAppUid || '').trim();
  const hash = contentHashForDedup(message);
  const imageUrl = String(
    (Array.isArray(message?.imageUrls) && message.imageUrls[0]) ||
      message?.thumbUrl ||
      message?.productInfo?.imageUrl ||
      ''
  ).trim();
  const productId = String(
    message?.productInfo?.productId ||
      message?.productInfo?.spuId ||
      message?.productInfo?.goodsId ||
      ''
  ).trim();
  const orderId = String(
    message?.orderInfo?.orderId || message?.orderInfo?.orderSn || ''
  ).trim();

  if (shopTitle && appCid && stableMsgId) {
    return `${shopTitle}::${appCid}::id::${stableMsgId}`;
  }

  if (contentType === 'image' && shopTitle && appCid && imageUrl && createAt) {
    return `${shopTitle}::${appCid}::img::${imageUrl}::${createAt}`;
  }
  if (contentType === 'product' && shopTitle && appCid && productId && createAt) {
    return `${shopTitle}::${appCid}::product::${productId}::${createAt}`;
  }
  if (contentType === 'order' && shopTitle && appCid && orderId && createAt) {
    return `${shopTitle}::${appCid}::order::${orderId}::${createAt}`;
  }
  if (shopTitle && appCid && createAt && (hash !== '0' || imageUrl || productId || orderId)) {
    return `${shopTitle}::${appCid}::ts::${createAt}::${senderAppUid}::${contentType}::${hash}::${imageUrl}::${productId}::${orderId}`;
  }
  if (shopTitle && appCid && hash !== '0') {
    return `${shopTitle}::${appCid}::fallback::${senderAppUid}::${contentType}::${hash}::${createAt || 0}`;
  }

  return `${shopTitle}::${appCid}::ephemeral::${senderAppUid}::${contentType}::${hash}::${createAt || 0}`;
}

function buildNotifyKey(message) {
  return buildCanonicalBuyerMessageKey(message);
}

function hasNotified(message, notifiedSet) {
  if (notifiedSet.has(buildNotifyKey(message))) return true;
  const msgId = extractDedupMsgId(message);
  const shopTitle = String(message?.shopTitle || '').trim();
  const appCid = String(message?.appCid || '').trim();
  if (msgId && shopTitle && appCid) {
    const idKey = `${shopTitle}::${appCid}::id::${msgId}`;
    if (notifiedSet.has(idKey)) return true;
  }
  return false;
}

function hasNotifiedPersisted(message) {
  return hasNotified(message, loadNotifiedSet());
}

function getActiveSessionAppCids(shopTitle) {
  const shopKey = normalizeShopKey(shopTitle);
  const all = readJson(SESSION_CONTEXT_FILE, {});
  const out = new Set();
  for (const [key, ctx] of Object.entries(all)) {
    const cid = String(ctx?.appCid || '').trim();
    if (!cid) continue;
    if (key.startsWith(`${shopKey}::`) || normalizeShopKey(ctx.shopTitle) === shopKey) {
      out.add(cid);
    }
  }
  return [...out];
}

function markNotified(message, notifiedSet) {
  notifiedSet.add(buildNotifyKey(message));
  saveNotifiedSet(notifiedSet);
}

function appendPending(record) {
  const list = trimPendingList(readJson(PENDING_FILE, []));
  const replyId = Number(record?.replyId);
  const buyerMsgId = String(record?.buyerMsgId || '').trim();
  let idx = -1;
  if (Number.isFinite(replyId) && buyerMsgId) {
    idx = list.findIndex(
      (p) => Number(p.replyId) === replyId && String(p.buyerMsgId || '') === buyerMsgId,
    );
  } else if (Number.isFinite(replyId)) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (Number(list[i]?.replyId) === replyId) {
        idx = i;
        break;
      }
    }
  }
  const next = {
    replyCount: 0,
    ...record,
    status: record.status || 'notified',
  };
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...next, replyCount: list[idx].replyCount || 0 };
  } else {
    list.push(next);
  }
  writeJson(PENDING_FILE, trimPendingList(list));
}

function loadSentMap() {
  return readJson(SENT_MAP_FILE, {});
}

function recordSentNotification(entry) {
  const map = loadSentMap();
  const wxMsgId = String(entry?.wxMsgId || '').trim();
  if (!wxMsgId) return false;
  const replyId = Number(entry.replyId);
  const prevByReply = Number.isFinite(replyId) ? lookupSentNotificationByReplyId(replyId) : null;
  const prev = map[wxMsgId] || prevByReply || null;
  const merged = {
    replyId: Number.isFinite(replyId) ? replyId : Number(prev?.replyId),
    shopTitle: String(entry.shopTitle || prev?.shopTitle || '').trim(),
    appCid: String(entry.appCid || prev?.appCid || '').trim(),
    buyerNick: String(entry.buyerNick || prev?.buyerNick || '').trim(),
    sentAt: Number(entry.sentAt || prev?.sentAt || Date.now()),
    targetWxid: String(entry.targetWxid || prev?.targetWxid || '').trim(),
  };
  map[wxMsgId] = merged;
  if (Number.isFinite(merged.replyId)) {
    map[`replyId:${merged.replyId}`] = { ...merged, wxMsgId };
  }
  writeJson(SENT_MAP_FILE, trimSentMap(map));
  return true;
}

function lookupSentNotificationByWxMsgId(wxMsgId) {
  const key = String(wxMsgId || '').trim();
  if (!key) return null;
  const map = loadSentMap();
  if (map[key]) return map[key];
  for (const k of Object.keys(map)) {
    if (String(k) === key) return map[k];
  }
  return null;
}

function lookupSentNotificationForQuote(quotedMsgId, fromWxid = '') {
  const quoteId = String(quotedMsgId || '').trim();
  if (!quoteId) return null;
  const sender = String(fromWxid || '').trim();

  const direct = lookupSentNotificationByWxMsgId(quoteId);
  if (direct && (!sender || !direct.targetWxid || direct.targetWxid === sender)) {
    return direct;
  }

  const map = loadSentMap();
  for (const [key, entry] of Object.entries(map)) {
    if (String(key) !== quoteId) continue;
    if (!sender || !entry?.targetWxid || entry.targetWxid === sender) {
      return entry;
    }
  }

  return direct;
}

function lookupSentNotificationByReplyId(replyId, fromWxid = '') {
  const num = Number(String(replyId || '').replace(/^#/, ''));
  if (!Number.isFinite(num)) return null;
  const sender = String(fromWxid || '').trim();
  const map = loadSentMap();
  const indexed = map[`replyId:${num}`];
  if (indexed) {
    const hit = { ...indexed, wxMsgId: String(indexed.wxMsgId || '').trim() };
    if (!sender || !hit.targetWxid || hit.targetWxid === sender) return hit;
  }
  let fallback = null;
  for (const [wxMsgId, entry] of Object.entries(map)) {
    if (String(wxMsgId).startsWith('replyId:')) continue;
    if (Number(entry?.replyId) !== num) continue;
    const hit = { ...entry, wxMsgId: String(entry?.wxMsgId || wxMsgId || '').trim() };
    if (!sender || !hit.targetWxid || hit.targetWxid === sender) return hit;
    if (!fallback) fallback = hit;
  }
  return fallback;
}

function extractNoticeFieldFromText(text, label) {
  const s = String(text || '');
  const withColon = s.match(new RegExp(`${label}[：:]\\s*([^\\n]+)`));
  if (withColon?.[1]) return withColon[1].trim();
  const withSpaces = s.match(new RegExp(`${label}\\s{2,}([^\\n]+)`));
  if (withSpaces?.[1]) return withSpaces[1].trim();
  const withSpace = s.match(new RegExp(`${label}\\s+([^\\n]+)`));
  if (withSpace?.[1]) return withSpace[1].trim();
  return '';
}

function parseNoticeContextFromText(text) {
  return {
    shopTitle: extractNoticeFieldFromText(text, '店铺'),
    buyerNick: extractNoticeFieldFromText(text, '买家'),
  };
}

function normalizeBuyerNickForMatch(nick) {
  return String(nick || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

function buyerNickMatches(a, b) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!left || !right) return false;
  if (left === right) return true;
  const na = normalizeBuyerNickForMatch(left);
  const nb = normalizeBuyerNickForMatch(right);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

function findSessionContextForBuyer(shopTitle, buyerNick = '') {
  const shopKey = normalizeShopKey(shopTitle);
  const nick = String(buyerNick || '').trim();
  const all = readJson(SESSION_CONTEXT_FILE, {});
  const matches = [];
  for (const ctx of Object.values(all)) {
    if (!ctx || typeof ctx !== 'object') continue;
    if (normalizeShopKey(ctx.shopTitle) !== shopKey) continue;
    if (nick && String(ctx.buyerNick || '').trim() && !buyerNickMatches(ctx.buyerNick, nick)) continue;
    matches.push(ctx);
  }
  if (!matches.length) return null;
  matches.sort((a, b) => Number(b.updatedAt || b.lastBuyerMsgAt || 0) - Number(a.updatedAt || a.lastBuyerMsgAt || 0));
  return matches[0];
}

function findReceiverCacheForShop(shopTitle, buyerNick = '') {
  const shopKey = normalizeShopKey(shopTitle);
  const nick = String(buyerNick || '').trim();
  const cache = readJson(APP_CID_RECEIVERS_FILE, {});
  const all = readJson(SESSION_CONTEXT_FILE, {});
  let fallback = null;

  for (const [key, uids] of Object.entries(cache)) {
    if (!Array.isArray(uids) || !uids.length) continue;
    if (!key.startsWith(`${shopKey}::`)) continue;
    const appCid = key.slice(shopKey.length + 2);
    if (!appCid) continue;
    const ctx = all[key] || getSessionContext(shopKey, appCid);
    if (nick && ctx?.buyerNick && !buyerNickMatches(ctx.buyerNick, nick)) continue;
    const hit = {
      shopTitle: shopKey,
      appCid,
      buyerNick: String(ctx?.buyerNick || nick || '买家').trim(),
      receiverAppUids: [...uids],
    };
    if (nick && ctx?.buyerNick && buyerNickMatches(ctx.buyerNick, nick)) return hit;
    if (!fallback) fallback = hit;
  }

  if (!fallback && nick) {
    for (const ctx of Object.values(all)) {
      if (!ctx || typeof ctx !== 'object') continue;
      if (normalizeShopKey(ctx.shopTitle) !== shopKey) continue;
      if (!buyerNickMatches(ctx.buyerNick, nick)) continue;
      const appCid = String(ctx.appCid || '').trim();
      const receiverAppUids = Array.isArray(ctx.receiverAppUids) && ctx.receiverAppUids.length
        ? ctx.receiverAppUids.filter(Boolean)
        : getReceiverAppUids(shopKey, appCid);
      if (!appCid || !receiverAppUids.length) continue;
      return {
        shopTitle: shopKey,
        appCid,
        buyerNick: String(ctx.buyerNick || nick).trim(),
        receiverAppUids,
      };
    }
  }

  return fallback;
}

function resolvePendingReply(options = {}) {
  return findPendingByReplyId(options.replyId);
}

function findPendingByReplyId(replyId) {
  const num = Number(String(replyId || '').replace(/^#/, ''));
  if (!Number.isFinite(num)) return null;
  const list = readJson(PENDING_FILE, []);
  const matches = list.filter((p) => Number(p.replyId) === num);
  if (!matches.length) return null;

  const latest = { ...matches[matches.length - 1] };
  for (let i = matches.length - 1; i >= 0; i--) {
    const item = matches[i];
    if (Array.isArray(item.receiverAppUids) && item.receiverAppUids.length) {
      latest.receiverAppUids = item.receiverAppUids;
      break;
    }
  }
  if (!latest.receiverAppUids?.length) {
    const ctx = getSessionContext(latest.shopTitle, latest.appCid);
    if (ctx?.receiverAppUids?.length) latest.receiverAppUids = ctx.receiverAppUids;
  }
  if (!latest.receiverAppUids?.length) {
    latest.receiverAppUids = getReceiverAppUids(latest.shopTitle, latest.appCid);
  }
  return latest;
}

function findOpenPendingForBuyer(message = {}) {
  const buyerMsgId = String(message.msgId || message.messageId || '').trim();
  const shopTitle = String(message.shopTitle || '').trim();
  const appCid = String(message.appCid || '').trim();
  if (!shopTitle || !appCid) return null;

  const list = readJson(PENDING_FILE, []);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const row = list[i];
    if (String(row.shopTitle || '').trim() !== shopTitle) continue;
    if (String(row.appCid || '').trim() !== appCid) continue;
    if (buyerMsgId && String(row.buyerMsgId || '').trim() !== buyerMsgId) continue;
    const status = String(row.status || '');
    if (!['notify_partial', 'notifying', 'notify_failed'].includes(status)) continue;
    return { ...row };
  }
  return null;
}

function normalizeShopKey(title) {
  return String(title || '')
    .replace(/-工作台\s*$/i, '')
    .trim();
}

function sessionContextKey(shopTitle, appCid) {
  return `${normalizeShopKey(shopTitle)}::${String(appCid || '').trim()}`;
}

function extractReceiverAppUidsFromMessage(message) {
  const raw = message?.raw && typeof message.raw === 'object' ? message.raw : {};
  const userMessage = raw?.userMessage || raw?.message || raw;
  const found = [];

  const arrays = [
    message?.receiverAppUids,
    raw?.receiverAppUids,
    userMessage?.receiverAppUids,
    raw?.body?.receiverAppUids,
  ];
  for (const arr of arrays) {
    if (Array.isArray(arr)) {
      for (const uid of arr) {
        const s = String(uid || '').trim();
        if (s) found.push(s);
      }
    }
  }

  const uidFields = [
    message?.senderAppUid,
    raw?.senderAppUid,
    userMessage?.senderAppUid,
    raw?.fromAppUid,
    raw?.buyerAppUid,
    raw?.customerAppUid,
    raw?.userAppUid,
    raw?.appUid,
    raw?.uid,
  ];
  for (const uid of uidFields) {
    const s = String(uid || '').trim();
    if (!s) continue;
    if (s.includes('#2#2#') || String(message?.senderType || '').toUpperCase() === 'CUSTOMER') {
      found.push(s);
    }
  }

  if (!found.length) {
    const fallback = String(
      message?.senderAppUid || raw?.senderAppUid || userMessage?.senderAppUid || ''
    ).trim();
    if (fallback) found.push(fallback);
  }

  return [...new Set(found)];
}

function saveSessionContext(message) {
  const shopTitle = String(message?.shopTitle || '').trim();
  const appCid = String(message?.appCid || '').trim();
  if (!shopTitle || !appCid) return null;

  const receiverAppUids = extractReceiverAppUidsFromMessage(message);
  const buyerAppUid = receiverAppUids[0] || String(message?.senderAppUid || '').trim();

  const ctx = {
    shopTitle: normalizeShopKey(shopTitle),
    appCid,
    buyerNick: String(message?.buyerNick || '买家').trim(),
    buyerMsgId: String(message?.msgId || message?.messageId || '').trim(),
    buyerAppUid,
    receiverAppUids,
    lastBuyerText: String(message?.text || '').trim(),
    lastBuyerMsgAt: Number(message?.createAt || Date.now()),
    source: message?.source || 'buyer_message_ws',
    updatedAt: Date.now(),
  };

  const all = readJson(SESSION_CONTEXT_FILE, {});
  all[sessionContextKey(shopTitle, appCid)] = ctx;
  writeJson(SESSION_CONTEXT_FILE, all);

  if (receiverAppUids.length) {
    rememberReceiverAppUids(shopTitle, appCid, receiverAppUids);
  }

  return ctx;
}

function getSessionContext(shopTitle, appCid) {
  const key = sessionContextKey(shopTitle, appCid);
  const all = readJson(SESSION_CONTEXT_FILE, {});
  return all[key] || null;
}

function getReceiverAppUidsForSend(shopTitle, appCid) {
  const ctx = getSessionContext(shopTitle, appCid);
  if (ctx?.receiverAppUids?.length) return [...ctx.receiverAppUids];
  return getReceiverAppUids(shopTitle, appCid);
}

function rememberReceiverAppUids(shopTitle, appCid, receiverAppUids) {
  const key = sessionContextKey(shopTitle, appCid);
  const cid = String(appCid || '').trim();
  if (!key || !cid) return;
  const uids = Array.isArray(receiverAppUids)
    ? receiverAppUids.map((u) => String(u || '').trim()).filter(Boolean)
    : [String(receiverAppUids || '').trim()].filter(Boolean);
  if (!uids.length) return;
  const cache = readJson(APP_CID_RECEIVERS_FILE, {});
  cache[key] = [...new Set(uids)];
  writeJson(APP_CID_RECEIVERS_FILE, cache);
}

function getReceiverAppUids(shopTitle, appCid) {
  const key = sessionContextKey(shopTitle, appCid);
  const cid = String(appCid || '').trim();
  if (!key && !cid) return [];
  const cache = readJson(APP_CID_RECEIVERS_FILE, {});
  if (Array.isArray(cache[key])) return cache[key];
  if (cid && Array.isArray(cache[cid])) return cache[cid];
  return [];
}

function loadSentReplies() {
  const raw = readJson(SENT_REPLIES_FILE, []);
  return Array.isArray(raw) ? raw : [];
}

function appendSentReply(record) {
  let list = loadSentReplies();
  list.push({
    replyId: Number(record.replyId),
    wechatReplyMsgId: String(record.wechatReplyMsgId || '').trim(),
    qianfanMsgId: String(record.qianfanMsgId || '').trim(),
    text: String(record.text || ''),
    sentAt: Number(record.sentAt || Date.now()),
    status: record.status || 'sent',
    ackConfirmed: record.ackConfirmed !== false,
    echoVerified: record.echoVerified === true,
  });
  if (list.length > MAX_SENT_REPLIES) {
    list = list.slice(list.length - MAX_SENT_REPLIES);
  }
  writeJson(SENT_REPLIES_FILE, list);
}

function hasSuccessfulReplyForReplyId(replyId) {
  const num = Number(replyId);
  return loadSentReplies().some((r) => Number(r.replyId) === num && r.status === 'sent');
}

function updatePendingAfterReply(replyId) {
  const num = Number(replyId);
  const list = readJson(PENDING_FILE, []);
  let changed = false;
  for (const item of list) {
    if (Number(item.replyId) !== num) continue;
    item.replyCount = Number(item.replyCount || 0) + 1;
    item.lastReplyAt = Date.now();
    if (item.status === 'used' || item.status === 'closed') item.status = 'notified';
    changed = true;
  }
  if (changed) writeJson(PENDING_FILE, trimPendingList(list));
}

function hydrateProcessedWechatReplyKeys() {
  const rows = loadSentReplies();
  const recent = rows.length > MAX_PROCESSED_WECHAT_REPLY_KEYS
    ? rows.slice(rows.length - MAX_PROCESSED_WECHAT_REPLY_KEYS)
    : rows;
  for (const row of recent) {
    const wxId = String(row.wechatReplyMsgId || '').trim();
    if (!wxId) continue;
    processedWechatReplyKeys.add(wxId);
    processedWechatReplyKeys.add(`${wxId}::${row.replyId}`);
  }
  trimSetTail(processedWechatReplyKeys, MAX_PROCESSED_WECHAT_REPLY_KEYS);
}

hydrateProcessedWechatReplyKeys();

function isDuplicateWechatReply({ wechatReplyMsgId, replyId, fromWxid, text }) {
  const wxId = String(wechatReplyMsgId || '').trim();
  if (wxId) {
    if (processedWechatReplyKeys.has(wxId)) return true;
    if (processedWechatReplyKeys.has(`${wxId}::${replyId}`)) return true;
    return false;
  }
  const fallback = `${fromWxid}::${replyId}::${normalizeMessageText(text)}::${Math.floor(Date.now() / 3000)}`;
  if (recentFallbackKeys.has(fallback)) return true;
  recentFallbackKeys.add(fallback);
  setTimeout(() => recentFallbackKeys.delete(fallback), 4000);
  return false;
}

function markWechatReplyProcessed({ wechatReplyMsgId, replyId }) {
  const wxId = String(wechatReplyMsgId || '').trim();
  if (!wxId) return;
  processedWechatReplyKeys.add(wxId);
  processedWechatReplyKeys.add(`${wxId}::${replyId}`);
  trimSetTail(processedWechatReplyKeys, MAX_PROCESSED_WECHAT_REPLY_KEYS);
}

function unmarkWechatReplyProcessed({ wechatReplyMsgId, replyId }) {
  const wxId = String(wechatReplyMsgId || '').trim();
  if (!wxId) return;
  processedWechatReplyKeys.delete(wxId);
  processedWechatReplyKeys.delete(`${wxId}::${replyId}`);
}

function startOfLocalDayMs(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function localDateKey(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function isToday(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return false;
  return localDateKey(n) === localDateKey(Date.now());
}

function countTodayForwards() {
  const replyIds = new Set();
  const sentMap = loadSentMap();
  const sentAtByReplyId = new Map();

  for (const entry of Object.values(sentMap)) {
    const replyId = Number(entry?.replyId);
    const sentAt = Number(entry?.sentAt || 0);
    if (!Number.isFinite(replyId) || replyId <= 0) continue;
    if (Number.isFinite(sentAt) && sentAt > 0) {
      sentAtByReplyId.set(replyId, sentAt);
    }
    if (isToday(sentAt)) {
      replyIds.add(replyId);
    }
  }

  const pending = readJson(PENDING_FILE, []);
  for (const item of pending) {
    const replyId = Number(item?.replyId);
    if (!Number.isFinite(replyId) || replyId <= 0) continue;
    if (item.status !== 'notified' && item.status !== 'used' && item.status !== 'closed') continue;
    const markerAt = Number(item.notifiedAt || sentAtByReplyId.get(replyId) || 0);
    if (isToday(markerAt)) replyIds.add(replyId);
  }

  return replyIds.size;
}

function countTodayReplies() {
  const replyIds = new Set();
  for (const row of loadSentReplies()) {
    const sentAt = Number(row?.sentAt || 0);
    const replyId = Number(row?.replyId);
    if (row?.status === 'sent' && Number.isFinite(replyId) && replyId > 0 && isToday(sentAt)) {
      replyIds.add(replyId);
    }
  }
  return replyIds.size;
}

function getTodayStats() {
  return {
    forwardCount: countTodayForwards(),
    replyCount: countTodayReplies(),
  };
}

module.exports = {
  nextReplyId,
  loadNotifiedSet,
  saveNotifiedSet,
  hasNotified,
  hasNotifiedPersisted,
  markNotified,
  appendPending,
  buildNotifyKey,
  buildCanonicalBuyerMessageKey,
  extractDedupMsgId,
  contentHashForDedup,
  normalizeMessageText,
  recordSentNotification,
  lookupSentNotificationByWxMsgId,
  lookupSentNotificationForQuote,
  lookupSentNotificationByReplyId,
  findSessionContextForBuyer,
  findReceiverCacheForShop,
  buyerNickMatches,
  parseNoticeContextFromText,
  extractReceiverAppUidsFromMessage,
  resolvePendingReply,
  findPendingByReplyId,
  findOpenPendingForBuyer,
  rememberReceiverAppUids,
  getReceiverAppUids,
  getReceiverAppUidsForSend,
  saveSessionContext,
  getSessionContext,
  getActiveSessionAppCids,
  normalizeShopKey,
  sessionContextKey,
  appendSentReply,
  hasSuccessfulReplyForReplyId,
  updatePendingAfterReply,
  isDuplicateWechatReply,
  markWechatReplyProcessed,
  unmarkWechatReplyProcessed,
  countTodayForwards,
  countTodayReplies,
  getTodayStats,
};
