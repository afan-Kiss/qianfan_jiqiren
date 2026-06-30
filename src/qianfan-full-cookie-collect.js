/**
 * 千帆四店完整 Cookie 采集（CDP 全量 + 多 URL + 最长值合并，确保含 a1）
 */
const { normalizeCookie, hashCookie } = require('./qianfan-cookie-collector');
const { println } = require('./utils');

const CRITICAL_COOKIE_NAMES = new Set([
  'a1',
  'web_session',
  'webBuild',
  'xsecappid',
  'webId',
  'gid',
  'unread',
  'access-token',
  'customer-sso-sid',
]);

const XHS_COOKIE_URLS = [
  'https://www.xiaohongshu.com',
  'https://edith.xiaohongshu.com',
  'https://walle.xiaohongshu.com',
  'https://ark.xiaohongshu.com',
  'https://customer.xiaohongshu.com',
  'https://pro.xiaohongshu.com',
  'https://seller.xiaohongshu.com',
  'https://fe.xiaohongshu.com',
  'https://zhaoshang.xiaohongshu.com',
];

function isXhsRelatedDomain(domain) {
  const d = String(domain || '').toLowerCase();
  return d.includes('xiaohongshu.com') || d.includes('xiaohongshu.net');
}

function cookieContainsA1(cookieStr) {
  return /(?:^|;\s*)a1=[^;]+/i.test(String(cookieStr || ''));
}

function extractCookieKeys(cookieStr) {
  const keys = [];
  for (const seg of String(cookieStr || '').split(';')) {
    const piece = seg.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    keys.push(piece.slice(0, eq).trim());
  }
  return [...new Set(keys)].sort();
}

function mergeCookiePartsPreferLongest(...parts) {
  const map = new Map();
  for (const part of parts) {
    for (const seg of String(part || '').split(';')) {
      const piece = seg.trim();
      if (!piece) continue;
      const eq = piece.indexOf('=');
      if (eq <= 0) continue;
      const name = piece.slice(0, eq).trim();
      const value = piece.slice(eq + 1).trim();
      if (!name) continue;
      const prev = map.get(name);
      if (!prev || value.length >= prev.length) {
        map.set(name, value);
      }
    }
  }
  return normalizeCookie([...map.entries()].map(([k, v]) => `${k}=${v}`).join('; '));
}

function scoreCookieEntry(entry) {
  const domain = String(entry?.domain || '').toLowerCase();
  let score = 0;
  if (domain === '.xiaohongshu.com') score += 30;
  else if (domain.startsWith('.')) score += 20;
  else if (isXhsRelatedDomain(domain)) score += 10;
  if (CRITICAL_COOKIE_NAMES.has(String(entry?.name || ''))) score += 5;
  score += Math.min(String(entry?.value || '').length, 500) / 500;
  return score;
}

function mergeCdpCookieEntries(list) {
  if (!Array.isArray(list)) return '';
  const map = new Map();
  for (const raw of list) {
    const name = String(raw?.name || '').trim();
    const value = String(raw?.value ?? '').trim();
    if (!name) continue;
    const domain = String(raw?.domain || '').toLowerCase();
    if (!isXhsRelatedDomain(domain) && !CRITICAL_COOKIE_NAMES.has(name)) continue;
    const entry = { name, value, domain, score: scoreCookieEntry(raw) };
    const prev = map.get(name);
    if (!prev || entry.score > prev.score || (entry.score === prev.score && value.length > prev.value.length)) {
      map.set(name, entry);
    }
  }
  return normalizeCookie([...map.values()].map((c) => `${c.name}=${c.value}`).join('; '));
}

async function ensureNetworkEnabled(client) {
  if (!client?.Network?.enable) return;
  try {
    await client.Network.enable({});
  } catch {
    // already enabled
  }
}

async function readAllCdpCookies(client, pageUrl) {
  const chunks = [];
  await ensureNetworkEnabled(client);

  if (client.Network?.getAllCookies) {
    try {
      const all = await client.Network.getAllCookies();
      const merged = mergeCdpCookieEntries(all?.cookies);
      if (merged) chunks.push(merged);
    } catch {
      // ignore
    }
  }

  const urls = new Set(XHS_COOKIE_URLS);
  if (pageUrl) urls.add(String(pageUrl).split('#')[0]);
  if (client.Network?.getCookies) {
    for (const url of urls) {
      try {
        const one = await client.Network.getCookies({ urls: [url] });
        const merged = mergeCdpCookieEntries(one?.cookies);
        if (merged) chunks.push(merged);
      } catch {
        // ignore per-url
      }
    }
  }

  return mergeCookiePartsPreferLongest(...chunks);
}

async function readPageDocumentCookie(client) {
  if (!client?.Runtime?.evaluate) return '';
  try {
    const evalRes = await client.Runtime.evaluate({
      expression: 'document.cookie || ""',
      returnByValue: true,
    });
    return normalizeCookie(evalRes?.result?.value || '');
  } catch {
    return '';
  }
}

async function collectFullCookiesFromBridge(bridge, options = {}) {
  if (!bridge?.client) return null;
  const client = bridge.client;
  const pageUrl = String(bridge.pageInfo?.url || bridge.lastSeenUrl || 'https://walle.xiaohongshu.com').trim();
  const headerCookie = normalizeCookie(bridge.lastRequestCookie || '');

  let cdpCookies = await readAllCdpCookies(client, pageUrl);
  let pageCookies = await readPageDocumentCookie(client);

  if (!cookieContainsA1(cdpCookies) && options.retryReload !== false && client.Page?.reload) {
    try {
      println(`[Cookie采集] ${bridge.shopTitle || '店铺'} 缺少 a1，尝试刷新页面后重采…`);
      await client.Page.reload({ ignoreCache: false });
      await sleep(3000);
      cdpCookies = await readAllCdpCookies(client, pageUrl);
      pageCookies = await readPageDocumentCookie(client);
    } catch {
      // ignore reload errors
    }
  }

  const cookie = mergeCookiePartsPreferLongest(cdpCookies, pageCookies, headerCookie);
  const keys = extractCookieKeys(cookie);
  const hasA1 = cookieContainsA1(cookie);

  return {
    cookie,
    cookieHash: hashCookie(cookie),
    hasA1,
    cookieKeyCount: keys.length,
    cookieKeys: keys,
    pageUrl,
    sources: {
      cdpLength: cdpCookies.length,
      pageLength: pageCookies.length,
      headerLength: headerCookie.length,
    },
  };
}

function logCookieCollectionDiagnostics(shopName, detail) {
  if (!detail) {
    println(`[Cookie采集] ${shopName}：未能读取 Cookie`);
    return;
  }
  println(`[Cookie采集] ${shopName} 当前URL：${detail.pageUrl || 'unknown'}`);
  println(
    `[Cookie采集] ${shopName} 读取 Cookie 数量：${detail.cookieKeyCount}，长度：${detail.cookie?.length || 0}，包含 a1：${detail.hasA1}`
  );
  if (detail.cookieKeys?.length) {
    println(`[Cookie采集] ${shopName} Cookie keys：${detail.cookieKeys.join(', ')}`);
  }
  if (!detail.hasA1) {
    println(
      `[Cookie采集] ${shopName} 缺少 a1：当前页面可能不是完整小红书商家后台登录环境，请打开/刷新该店铺商家后台后重试`
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  CRITICAL_COOKIE_NAMES,
  XHS_COOKIE_URLS,
  cookieContainsA1,
  extractCookieKeys,
  mergeCookiePartsPreferLongest,
  mergeCdpCookieEntries,
  collectFullCookiesFromBridge,
  logCookieCollectionDiagnostics,
};
