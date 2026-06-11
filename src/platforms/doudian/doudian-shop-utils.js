const crypto = require('crypto');

const KNOWN_MULTI_SHOP_HINTS = ['XY祥钰珠宝', '梵诗娅珠宝', '263636465', '276595872'];

function pickFirst(...values) {
  for (const v of values) {
    const s = String(v ?? '').trim();
    if (s) return s;
  }
  return '';
}

function buildShopKey(info = {}) {
  const shopId = pickFirst(info.shopId, info.activeShopIdFromDom);
  const sessionPartitionKey = pickFirst(info.sessionPartitionKey);
  const bridgeId = pickFirst(info.bridgeId);
  if (shopId) return `shop:${shopId}`;
  if (sessionPartitionKey) return `partition:${sessionPartitionKey}`;
  if (bridgeId) return `unknown:${bridgeId}`;
  return 'unknown:global';
}

function maskAccountId(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^1\d{10}$/.test(s)) return `${s.slice(0, 3)}****${s.slice(-4)}`;
  if (s.includes('@')) {
    const [user, domain] = s.split('@');
    if (!domain) return '***@***';
    const head = user.length <= 2 ? '*' : `${user.slice(0, 2)}***`;
    return `${head}@${domain}`;
  }
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

function extractShopFromPayload(payload = {}) {
  const shopId = pickFirst(
    payload.shopId,
    payload.activeShopIdFromDom,
    payload.info?.shopId,
    payload.info?.activeShopIdFromDom
  );
  const shopName = pickFirst(
    payload.shopName,
    payload.activeShopNameFromDom,
    payload.info?.shopName,
    payload.info?.activeShopNameFromDom
  );
  return {
    shopId,
    shopName,
    accountId: pickFirst(payload.accountId, payload.info?.accountId),
    sessionPartitionKey: pickFirst(payload.sessionPartitionKey, payload.info?.sessionPartitionKey),
    persistAccountId: pickFirst(payload.persistAccountId, payload.info?.persistAccountId),
    loginDomainType: pickFirst(payload.loginDomainType, payload.info?.loginDomainType),
    activeShopNameFromDom: pickFirst(payload.activeShopNameFromDom, payload.info?.activeShopNameFromDom),
    activeShopIdFromDom: pickFirst(payload.activeShopIdFromDom, payload.info?.activeShopIdFromDom),
  };
}

function mergePageInfo(payload = {}) {
  const shop = extractShopFromPayload(payload);
  return {
    href: pickFirst(payload.href, payload.url, payload.info?.href),
    title: pickFirst(payload.title, payload.info?.title),
    readyState: pickFirst(payload.readyState, payload.info?.readyState),
    visibilityState: pickFirst(payload.visibilityState, payload.info?.visibilityState),
    hasFocus: Boolean(payload.hasFocus ?? payload.info?.hasFocus),
    isImWorkspace: Boolean(payload.isImWorkspace ?? payload.info?.isImWorkspace),
    chatListExists: Boolean(payload.chatListExists ?? payload.info?.chatListExists),
    inputExists: Boolean(payload.inputExists ?? payload.info?.inputExists),
    bodyTextLength: Number(payload.bodyTextLength ?? payload.info?.bodyTextLength ?? 0),
    ...shop,
  };
}

function hashText(text) {
  return crypto.createHash('md5').update(String(text || '')).digest('hex').slice(0, 16);
}

function scoreImBridge(info = {}) {
  let score = 0;
  if (info.isImWorkspace) score += 100;
  if (info.shopId || info.shopName) score += 40;
  if (info.visibilityState === 'visible') score += 20;
  if (info.hasFocus) score += 15;
  if (info.chatListExists) score += 10;
  if (info.inputExists) score += 10;
  score += Math.min(20, Math.floor((info.bodyTextLength || 0) / 500));
  score += Math.min(15, (info.lastHeartbeatAt ? 1 : 0) * 15);
  return score;
}

function maskMessageForReport(message = {}) {
  return {
    shopId: message.shopId || '',
    shopName: message.shopName || '',
    conversationId: message.conversationId || '',
    buyerName: message.buyerName ? `${String(message.buyerName).slice(0, 1)}*` : '',
    direction: message.direction || '',
    messageType: message.messageType || '',
    text: String(message.text || '').slice(0, 120),
    source: message.source || '',
    bridgeId: message.bridgeId ? `${String(message.bridgeId).slice(0, 12)}...` : '',
  };
}

module.exports = {
  KNOWN_MULTI_SHOP_HINTS,
  pickFirst,
  buildShopKey,
  maskAccountId,
  extractShopFromPayload,
  mergePageInfo,
  hashText,
  scoreImBridge,
  maskMessageForReport,
};
