/**
 * 协议配置 Cookie 兜底 — 从主播分析系统本机 API 读取
 */
const SHOP_KEY_BY_TITLE = {
  祥钰珠宝: 'xiangyu',
  XY祥钰珠宝: 'xyxiangyu',
  拾玉居和田玉: 'shiyuju',
  和田雅玉: 'hetianyayu',
};

const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

function resolveShopKey(shopTitle) {
  const title = String(shopTitle || '').trim();
  if (SHOP_KEY_BY_TITLE[title]) return SHOP_KEY_BY_TITLE[title];
  for (const [name, key] of Object.entries(SHOP_KEY_BY_TITLE)) {
    if (title.includes(name) || name.includes(title)) return key;
  }
  return '';
}

async function fetchCookieFromAnalyst(shopTitle) {
  const shopKey = resolveShopKey(shopTitle);
  if (!shopKey) return null;

  const cached = cache.get(shopKey);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.cookie;

  const base = String(
    process.env.QIANFAN_ANALYST_COOKIE_BASE_URL || 'http://127.0.0.1:4723'
  ).replace(/\/$/, '');
  const url = `${base}/api/shop-cookies/plain?shopKey=${encodeURIComponent(shopKey)}`;

  try {
    const res = await fetch(url, { method: 'GET' });
    const json = await res.json().catch(() => ({}));
    const payload = json?.data || json;
    const cookie = String(payload?.cookie || '').trim();
    if (!res.ok || cookie.length < 80) return cached?.cookie || null;
    cache.set(shopKey, { at: Date.now(), cookie });
    return cookie;
  } catch {
    return cached?.cookie || null;
  }
}

async function applyAnalystCookieToShopConfig(shopConfig) {
  if (!shopConfig || typeof shopConfig !== 'object') return shopConfig;
  const current = String(shopConfig.cookie || '').trim();
  if (current.length >= 400 && current.includes('a1=')) return shopConfig;

  const cookie = await fetchCookieFromAnalyst(shopConfig.shopTitle);
  if (!cookie) return shopConfig;

  return { ...shopConfig, cookie, cookieSource: 'analyst' };
}

module.exports = {
  fetchCookieFromAnalyst,
  applyAnalystCookieToShopConfig,
  resolveShopKey,
};
