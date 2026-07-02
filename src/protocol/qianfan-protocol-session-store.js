/**
 * 纯协议桥接 — 会话缓存（appCid / receiverAppUids / buyerUserId）
 */
const fs = require('fs');
const path = require('path');
const { resolveProjectRoot } = require('../shared/app-root');

function buildReceiverAppUid(buyerUserId) {
  const uid = String(buyerUserId || '').trim();
  if (!uid || uid.length < 10) return '';
  return `1#2#2#${uid}`;
}

function uidFromReceiver(receiverAppUid) {
  const s = String(receiverAppUid || '').trim();
  const m = s.match(/1#2#2#([0-9a-f]+)/i);
  return m ? m[1] : '';
}

function defaultDataDir() {
  return path.join(resolveProjectRoot(), 'data');
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadReceiverMap(dataDir = defaultDataDir()) {
  const raw = readJsonSafe(path.join(dataDir, 'app-cid-receivers.json'));
  return raw && typeof raw === 'object' ? raw : {};
}

function loadSessionContext(dataDir = defaultDataDir()) {
  const raw = readJsonSafe(path.join(dataDir, 'qianfan-session-context.json'));
  return raw && typeof raw === 'object' ? raw : {};
}

function persistSession({ shopTitle, appCid, buyerUserId, buyerNick, receiverAppUids, dataDir = defaultDataDir() }) {
  const shop = String(shopTitle || '').trim();
  const cid = String(appCid || '').trim();
  const uid = String(buyerUserId || '').trim();
  if (!shop || !cid) return;

  const recv =
    Array.isArray(receiverAppUids) && receiverAppUids.length
      ? receiverAppUids.filter(Boolean)
      : uid
        ? [buildReceiverAppUid(uid)].filter(Boolean)
        : [];

  const ctxPath = path.join(dataDir, 'qianfan-session-context.json');
  const mapPath = path.join(dataDir, 'app-cid-receivers.json');
  fs.mkdirSync(dataDir, { recursive: true });

  const ctx = loadSessionContext(dataDir) || {};
  ctx[`${shop}::${cid}`] = {
    shopTitle: shop,
    appCid: cid,
    buyerNick: String(buyerNick || '').trim(),
    buyerAppUid: recv[0] || '',
    receiverAppUids: recv,
    source: 'protocol_bridge',
    updatedAt: Date.now(),
  };
  fs.writeFileSync(ctxPath, `${JSON.stringify(ctx, null, 2)}\n`, 'utf8');

  const map = loadReceiverMap(dataDir) || {};
  map[`${shop}::${cid}`] = recv;
  fs.writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}

function resolveSessionFromStore({ shopTitle, buyerNick, buyerUserId, appCid, receiverAppUids, dataDir = defaultDataDir() }) {
  const shop = String(shopTitle || '').trim();
  const cid = String(appCid || '').trim();
  const uid = String(buyerUserId || '').trim();
  const nick = String(buyerNick || '').trim();
  const derivedRecv = uid ? [buildReceiverAppUid(uid)].filter(Boolean) : [];

  if (cid) {
    const ctx = loadSessionContext(dataDir);
    const hit = ctx?.[`${shop}::${cid}`];
  const recv =
      Array.isArray(receiverAppUids) && receiverAppUids.length
        ? receiverAppUids
        : hit?.receiverAppUids?.length
          ? hit.receiverAppUids
          : derivedRecv;
    return {
      shopTitle: shop,
      appCid: cid,
      buyerNick: nick || hit?.buyerNick || '',
      buyerUserId: uid || uidFromReceiver(recv[0]),
      receiverAppUids: recv,
      source: hit?.source || 'request_app_cid',
    };
  }

  const ctx = loadSessionContext(dataDir);
  for (const row of Object.values(ctx || {})) {
    if (shop && row.shopTitle !== shop) continue;
    const rowUid = uidFromReceiver(row.buyerAppUid || row.receiverAppUids?.[0]);
    if (uid && rowUid === uid) {
      return {
        shopTitle: row.shopTitle || shop,
        appCid: row.appCid,
        buyerNick: nick || row.buyerNick || '',
        buyerUserId: uid,
        receiverAppUids: row.receiverAppUids || derivedRecv,
        source: row.source || 'session_context',
      };
    }
    if (nick && row.buyerNick && String(row.buyerNick).includes(nick)) {
      return {
        shopTitle: row.shopTitle || shop,
        appCid: row.appCid,
        buyerNick: row.buyerNick,
        buyerUserId: rowUid || uid,
        receiverAppUids: row.receiverAppUids || derivedRecv,
        source: row.source || 'session_context_nick',
      };
    }
  }

  const map = loadReceiverMap(dataDir);
  for (const [key, recv] of Object.entries(map || {})) {
    if (shop && !key.startsWith(`${shop}::`)) continue;
    const keyCid = key.split('::').pop();
    const rowUid = uidFromReceiver(recv?.[0]);
    if (uid && rowUid === uid) {
      return {
        shopTitle: shop || key.split('::')[0],
        appCid: keyCid,
        buyerNick: nick,
        buyerUserId: uid,
        receiverAppUids: recv,
        source: 'receiver_map',
      };
    }
  }

  if (uid && derivedRecv.length) {
    return {
      shopTitle: shop,
      appCid: '',
      buyerNick: nick,
      buyerUserId: uid,
      receiverAppUids: derivedRecv,
      source: 'derived_uid',
    };
  }

  return null;
}

module.exports = {
  buildReceiverAppUid,
  uidFromReceiver,
  loadReceiverMap,
  loadSessionContext,
  persistSession,
  resolveSessionFromStore,
  defaultDataDir,
};
