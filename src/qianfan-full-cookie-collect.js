/**
 * 千帆四店 Cookie 采集：优先 CDP Network 请求头 Cookie，只读合并上传
 */
const CDP = require('chrome-remote-interface');
const { normalizeCookie, hashCookie } = require('./qianfan-cookie-collector');
const config = require('./wechat/wxbot-new-config');
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
  'access-token-ark.xiaohongshu.com',
  'access-token-walle.xiaohongshu.com',
]);

const ARK_TOKEN_KEY = 'access-token-ark.xiaohongshu.com';
const WALLE_TOKEN_KEY = 'access-token-walle.xiaohongshu.com';

const DEFAULT_NETWORK_HEADER_WAIT_MS = 3000;

function isXhsRelatedDomain(domain) {
  const d = String(domain || '').toLowerCase();
  return d.includes('xiaohongshu.com') || d.includes('xiaohongshu.net');
}

function isXhsRelatedRequestUrl(url) {
  const u = String(url || '').toLowerCase();
  return (
    u.includes('xiaohongshu.com') ||
    u.includes('xiaohongshu.net') ||
    u.includes('impaas') ||
    u.includes('qianfan')
  );
}

function cookieContainsA1(cookieStr) {
  return /(?:^|;\s*)a1=[^;]+/i.test(String(cookieStr || ''));
}

function cookieContainsArkToken(cookieStr) {
  const text = String(cookieStr || '');
  return (
    /(?:^|;\s*)access-token-ark\.xiaohongshu\.com=[^;]+/i.test(text) ||
    /(?:^|;\s*)access-token-ark=[^;]+/i.test(text)
  );
}

function cookieContainsWalleToken(cookieStr) {
  const text = String(cookieStr || '');
  return (
    /(?:^|;\s*)access-token-walle\.xiaohongshu\.com=[^;]+/i.test(text) ||
    /(?:^|;\s*)access-token-walle=[^;]+/i.test(text)
  );
}

function extractCookieValueByName(cookieStr, name) {
  const target = String(name || '').trim();
  if (!target) return '';
  for (const seg of String(cookieStr || '').split(';')) {
    const piece = seg.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    const key = piece.slice(0, eq).trim();
    if (key === target) return piece.slice(eq + 1).trim();
  }
  return '';
}

function isArkRelatedRequestUrl(url) {
  const u = String(url || '').toLowerCase();
  return (
    u.includes('ark.xiaohongshu.com') ||
    u.includes('/api/ark/') ||
    u.includes('/api/edith/') ||
    u.includes('/api/order') ||
    u.includes('/app-order/') ||
    u.includes('app-seller')
  );
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
  if (!Array.isArray(list)) return { cookie: '', a1Meta: null };
  const map = new Map();
  let a1Meta = null;
  for (const raw of list) {
    const name = String(raw?.name || '').trim();
    const value = String(raw?.value ?? '').trim();
    if (!name) continue;
    const domain = String(raw?.domain || '').toLowerCase();
    if (!isXhsRelatedDomain(domain) && !CRITICAL_COOKIE_NAMES.has(name)) continue;
    if (name === 'a1' && value) {
      a1Meta = {
        domain: raw.domain || '',
        path: raw.path || '',
        httpOnly: Boolean(raw.httpOnly),
        secure: Boolean(raw.secure),
        sameSite: raw.sameSite || '',
      };
    }
    const entry = { name, value, domain, score: scoreCookieEntry(raw) };
    const prev = map.get(name);
    if (!prev || entry.score > prev.score || (entry.score === prev.score && value.length > prev.value.length)) {
      map.set(name, entry);
    }
  }
  return {
    cookie: normalizeCookie([...map.values()].map((c) => `${c.name}=${c.value}`).join('; ')),
    a1Meta,
  };
}

function parseSetCookieHeader(setCookieRaw) {
  const parts = [];
  const text = String(setCookieRaw || '');
  if (!text) return parts;
  for (const seg of text.split(/\n|,(?=[^;]+?=)/)) {
    const piece = seg.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    const name = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).split(';')[0].trim();
    if (name && value) parts.push(`${name}=${value}`);
  }
  return parts;
}

function extractCookieHeaderFromHeaders(headers) {
  if (!headers || typeof headers !== 'object') return '';
  return String(headers.Cookie || headers.cookie || '').trim();
}

function associatedCookiesToHeader(associatedCookies) {
  if (!Array.isArray(associatedCookies)) return '';
  const parts = [];
  for (const row of associatedCookies) {
    const c = row?.cookie || row;
    const name = String(c?.name || '').trim();
    const value = String(c?.value ?? '').trim();
    if (name) parts.push(`${name}=${value}`);
  }
  return normalizeCookie(parts.join('; '));
}

function extractSetCookieHeaderParts(headers) {
  if (!headers || typeof headers !== 'object') return '';
  const pairs = [];
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() !== 'set-cookie') continue;
    pairs.push(...parseSetCookieHeader(value));
  }
  return normalizeCookie(pairs.join('; '));
}

async function ensureCdpDomainsEnabled(client) {
  if (client?.Network?.enable) {
    try {
      await client.Network.enable({});
    } catch {
      // already enabled
    }
  }
  if (client?.Page?.enable) {
    try {
      await client.Page.enable();
    } catch {
      // ignore
    }
  }
  if (client?.Runtime?.enable) {
    try {
      await client.Runtime.enable();
    } catch {
      // ignore
    }
  }
}

async function getPageTargetMeta(client) {
  const meta = { targetId: '', browserContextId: '' };
  if (!client?.Target?.getTargetInfo) return meta;
  try {
    const info = await client.Target.getTargetInfo();
    meta.targetId = String(info?.targetInfo?.targetId || '').trim();
    meta.browserContextId = String(info?.targetInfo?.browserContextId || '').trim();
  } catch {
    // ignore
  }
  return meta;
}

function mergeBridgeNetworkHeaderCookies(bridge) {
  if (!bridge) return '';
  return mergeCookiePartsPreferLongest(
    bridge.mergedNetworkHeaderCookie,
    bridge.lastArkRequestCookie,
    bridge.lastOrderRequestCookie,
    bridge.lastWalleRequestCookie,
    bridge.lastRequestCookie
  );
}

function shouldCollectNetworkCookie(url, cookieStr, associatedCookies) {
  if (isXhsRelatedRequestUrl(url)) return true;
  const cookie = String(cookieStr || '').trim();
  if (cookie && (cookieContainsA1(cookie) || cookieContainsArkToken(cookie) || cookieContainsWalleToken(cookie))) {
    return true;
  }
  if (!Array.isArray(associatedCookies)) return false;
  for (const row of associatedCookies) {
    const domain = String(row?.cookie?.domain || '').toLowerCase();
    if (isXhsRelatedDomain(domain)) return true;
    const name = String(row?.cookie?.name || '').trim();
    if (CRITICAL_COOKIE_NAMES.has(name)) return true;
  }
  return false;
}

function createNetworkHeaderCookieCollector(client) {
  const buckets = {
    requestWillBeSent: [],
    requestWillBeSentExtraInfo: [],
    responseReceivedExtraInfo: [],
  };
  const requestUrlById = new Map();
  let matchedRequestCount = 0;

  const pushChunk = (bucket, cookieStr, url, associatedCookies) => {
    const cookie = String(cookieStr || '').trim();
    if (!cookie || !shouldCollectNetworkCookie(url, cookie, associatedCookies)) return;
    buckets[bucket].push(cookie);
    matchedRequestCount += 1;
  };

  const onRequestWillBeSent = (params) => {
    const requestId = String(params?.requestId || '').trim();
    const url = String(params?.request?.url || '');
    if (requestId && url) requestUrlById.set(requestId, url);
    const cookie = extractCookieHeaderFromHeaders(params?.request?.headers);
    pushChunk('requestWillBeSent', cookie, url);
  };

  const onRequestWillBeSentExtraInfo = (params) => {
    const requestId = String(params?.requestId || '').trim();
    const url = requestUrlById.get(requestId) || '';
    const associatedCookies = params?.associatedCookies;
    const cookie = extractCookieHeaderFromHeaders(params?.headers);
    pushChunk('requestWillBeSentExtraInfo', cookie, url, associatedCookies);
    const assoc = associatedCookiesToHeader(associatedCookies);
    pushChunk('requestWillBeSentExtraInfo', assoc, url, associatedCookies);
  };

  const onResponseReceivedExtraInfo = (params) => {
    const requestId = String(params?.requestId || '').trim();
    const url = String(params?.url || requestUrlById.get(requestId) || '');
    const setCookie = extractSetCookieHeaderParts(params?.headers);
    pushChunk('responseReceivedExtraInfo', setCookie, url);
  };

  let attached = false;

  async function enable() {
    await ensureCdpDomainsEnabled(client);
    if (attached) return;
    attached = true;
    try {
      client.Network.requestWillBeSent(onRequestWillBeSent);
    } catch {
      // ignore
    }
    try {
      if (client.Network.requestWillBeSentExtraInfo) {
        client.Network.requestWillBeSentExtraInfo(onRequestWillBeSentExtraInfo);
      }
    } catch {
      // ignore
    }
    try {
      if (client.Network.responseReceivedExtraInfo) {
        client.Network.responseReceivedExtraInfo(onResponseReceivedExtraInfo);
      }
    } catch {
      // ignore
    }
  }

  function mergeAll() {
    return mergeCookiePartsPreferLongest(
      ...buckets.requestWillBeSent,
      ...buckets.requestWillBeSentExtraInfo,
      ...buckets.responseReceivedExtraInfo
    );
  }

  function stats() {
    return {
      matchedRequestCount,
      requestWillBeSent: buckets.requestWillBeSent.length,
      requestWillBeSentExtraInfo: buckets.requestWillBeSentExtraInfo.length,
      responseReceivedExtraInfo: buckets.responseReceivedExtraInfo.length,
    };
  }

  async function waitCollect(waitMs = DEFAULT_NETWORK_HEADER_WAIT_MS) {
    await sleep(waitMs);
    return { cookie: mergeAll(), stats: stats() };
  }

  return { enable, waitCollect, mergeNow: mergeAll, stats };
}

function ensureBridgeNetworkHeaderListeners(client, bridge) {
  if (!client?.Network || !bridge || bridge._networkHeaderListenersAttached) return;
  bridge._networkHeaderListenersAttached = true;
  const requestUrlById = new Map();
  const { noteBridgeRequestCookie } = require('./qianfan-cookie-collector');

  const ingest = (cookieStr, url, associatedCookies) => {
    const merged = mergeCookiePartsPreferLongest(
      String(cookieStr || '').trim(),
      associatedCookiesToHeader(associatedCookies)
    );
    if (!merged || !shouldCollectNetworkCookie(url, merged, associatedCookies)) return;
    noteBridgeRequestCookie(bridge, merged, url);
  };

  void ensureCdpDomainsEnabled(client);

  try {
    client.Network.requestWillBeSent((params) => {
      const requestId = String(params?.requestId || '').trim();
      const url = String(params?.request?.url || '');
      if (requestId && url) requestUrlById.set(requestId, url);
      ingest(extractCookieHeaderFromHeaders(params?.request?.headers), url);
    });
  } catch {
    // ignore
  }
  try {
    if (client.Network.requestWillBeSentExtraInfo) {
      client.Network.requestWillBeSentExtraInfo((params) => {
        const url = requestUrlById.get(String(params?.requestId || '').trim()) || '';
        ingest(extractCookieHeaderFromHeaders(params?.headers), url, params?.associatedCookies);
      });
    }
  } catch {
    // ignore
  }
  try {
    if (client.Network.responseReceivedExtraInfo) {
      client.Network.responseReceivedExtraInfo((params) => {
        const requestId = String(params?.requestId || '').trim();
        const url = String(params?.url || requestUrlById.get(requestId) || '');
        ingest(extractSetCookieHeaderParts(params?.headers), url);
      });
    }
  } catch {
    // ignore
  }
}

const JAR_FALLBACK_URLS = [
  'https://walle.xiaohongshu.com',
  'https://ark.xiaohongshu.com',
  'https://edith.xiaohongshu.com',
  'https://pro.xiaohongshu.com',
  'https://seller.xiaohongshu.com',
  'https://customer.xiaohongshu.com',
];

async function readJarCookiesFallback(client, pageUrl) {
  if (!client?.Network?.getAllCookies) return { cookie: '', a1Meta: null, count: 0 };
  await ensureCdpDomainsEnabled(client);
  const mergedLists = [];
  try {
    const all = await client.Network.getAllCookies();
    if (Array.isArray(all?.cookies)) mergedLists.push(...all.cookies);
  } catch {
    // ignore
  }
  if (client.Network.getCookies) {
    const urls = [...new Set([pageUrl, ...JAR_FALLBACK_URLS].filter(Boolean))];
    for (const url of urls) {
      try {
        const scoped = await client.Network.getCookies({ urls: [url] });
        if (Array.isArray(scoped?.cookies)) mergedLists.push(...scoped.cookies);
      } catch {
        // ignore
      }
    }
  }
  const merged = mergeCdpCookieEntries(mergedLists);
  return {
    cookie: merged.cookie,
    a1Meta: merged.a1Meta,
    count: mergedLists.length,
  };
}

function buildSourceDiag(label, cookieStr, extra = {}) {
  const keys = extractCookieKeys(cookieStr);
  return {
    label,
    exists: Boolean(cookieStr),
    count: keys.length,
    length: cookieStr.length,
    keys,
    containsA1: cookieContainsA1(cookieStr),
    containsArkToken: cookieContainsArkToken(cookieStr),
    containsWalleToken: cookieContainsWalleToken(cookieStr),
    ...extra,
  };
}

function logCookieDiagnostics(shopName, diag) {
  println(`[Cookie诊断] ${shopName}`);
  if (diag.pageTitle) println(`[Cookie诊断] pageTitle=${diag.pageTitle}`);
  if (diag.url) println(`[Cookie诊断] url=${diag.url}`);
  if (diag.targetId) println(`[Cookie诊断] targetId=${diag.targetId}`);
  if (diag.browserContextId) println(`[Cookie诊断] browserContextId=${diag.browserContextId}`);

  for (const src of diag.sources || []) {
    println(
      `[Cookie诊断] ${src.label} count=${src.count ?? src.matchedRequestCount ?? 0} length=${src.length} containsA1=${src.containsA1} containsArkToken=${src.containsArkToken} keys=${src.keys.join(',') || '(none)'}`
    );
  }

  if (diag.beforeMergeKeys?.length) {
    println(`[Cookie诊断] 合并前 keys=${diag.beforeMergeKeys.join(',')}`);
  }
  if (diag.afterMergeKeys?.length) {
    println(`[Cookie诊断] 合并后 keys=${diag.afterMergeKeys.join(',')}`);
  }
  println(
    `[Cookie诊断] merged count=${diag.mergedCount} length=${diag.mergedLength} containsA1=${diag.containsA1} containsArkToken=${diag.containsArkToken} containsWalleToken=${diag.containsWalleToken}`
  );
  if (diag.networkHeaderStats) {
    println(
      `[Cookie诊断] networkHeaderStats matched=${diag.networkHeaderStats.matchedRequestCount || 0} willBeSent=${diag.networkHeaderStats.requestWillBeSent || 0} extraInfo=${diag.networkHeaderStats.requestWillBeSentExtraInfo || 0} responseExtra=${diag.networkHeaderStats.responseReceivedExtraInfo || 0}`
    );
  }
  if (diag.payloadContainsA1 != null) {
    println(`[Cookie诊断] payload cookie containsA1=${diag.payloadContainsA1}`);
  }
  if (diag.payloadContainsArkToken != null) {
    println(`[Cookie诊断] payload cookie containsArkToken=${diag.payloadContainsArkToken}`);
  }
  if (!diag.containsA1) {
    println(`[Cookie诊断] ${shopName} 缺少 a1，未从 Network 请求头/CDP 合并到完整 Cookie`);
  } else if (!diag.containsArkToken) {
    println(
      `[Cookie诊断] ${shopName} 缺少 access-token-ark，请在该店千帆产生订单/ark 请求后再提交（本次只读采集，不跳页面）`
    );
  }
}

async function collectFullCookiesFromBridge(bridge, options = {}) {
  if (!bridge?.client) return null;
  const readOnly = options.readOnly !== false;
  const client = bridge.client;
  const pageUrl = String(bridge.pageInfo?.url || bridge.lastSeenUrl || 'https://walle.xiaohongshu.com').trim();
  const pageTitle = String(bridge.pageInfo?.pageTitle || bridge.pageInfo?.title || bridge.shopTitle || '').trim();
  const targetMeta = await getPageTargetMeta(client);
  const waitMs = Number(options.networkHeaderWaitMs ?? DEFAULT_NETWORK_HEADER_WAIT_MS);

  const bridgeHeaders = mergeBridgeNetworkHeaderCookies(bridge);
  ensureBridgeNetworkHeaderListeners(client, bridge);
  const collector = createNetworkHeaderCookieCollector(client);
  await collector.enable();

  if (readOnly) {
    println(`[Cookie采集] readOnly=true，监听 Network 请求头 Cookie ${waitMs}ms（不刷新/不跳转页面）`);
  }

  const waited = await collector.waitCollect(waitMs);
  const liveHeaders = waited.cookie;
  const networkHeaderStats = waited.stats;

  let jarFallback = { cookie: '', a1Meta: null, count: 0 };
  if (options.includeJarFallback !== false) {
    jarFallback = await readJarCookiesFallback(client, pageUrl);
  }

  const beforeParts = [bridgeHeaders, liveHeaders, jarFallback.cookie].filter(Boolean);
  const beforeMergeKeys = [...new Set(beforeParts.flatMap((p) => extractCookieKeys(p)))].sort();
  const cookie = mergeCookiePartsPreferLongest(...beforeParts);
  const afterMergeKeys = extractCookieKeys(cookie);
  const hasA1 = cookieContainsA1(cookie);
  const hasArk = cookieContainsArkToken(cookie);
  const hasWalle = cookieContainsWalleToken(cookie);

  const diagnostics = {
    shopName: bridge.shopTitle || '',
    pageTitle,
    url: pageUrl,
    readOnly,
    targetId: targetMeta.targetId || bridge.pageInfo?.targetId || '',
    browserContextId: targetMeta.browserContextId || '',
    sources: [
      buildSourceDiag('bridge.networkHeaders', bridgeHeaders),
      buildSourceDiag('network.headersMerged', liveHeaders, networkHeaderStats),
      buildSourceDiag('jar.getAllCookies(fallback)', jarFallback.cookie, { count: jarFallback.count }),
    ],
    beforeMergeKeys,
    afterMergeKeys,
    mergedCount: afterMergeKeys.length,
    mergedLength: cookie.length,
    containsA1: hasA1,
    containsArkToken: hasArk,
    containsWalleToken: hasWalle,
    networkHeaderStats,
    a1Meta: jarFallback.a1Meta,
  };

  if (options.logDiagnostics !== false) {
    logCookieDiagnostics(bridge.shopTitle || pageTitle || '店铺', diagnostics);
  }

  return {
    cookie,
    cookieHash: hashCookie(cookie),
    hasA1,
    hasArk,
    hasWalle,
    cookieKeyCount: afterMergeKeys.length,
    cookieKeys: afterMergeKeys,
    pageUrl,
    pageTitle,
    targetId: diagnostics.targetId,
    browserContextId: diagnostics.browserContextId,
    diagnostics,
    sources: {
      bridgeHeaderLength: bridgeHeaders.length,
      liveHeaderLength: liveHeaders.length,
      jarFallbackLength: jarFallback.cookie.length,
    },
  };
}

function logCookieCollectionDiagnostics(shopName, detail) {
  if (!detail) {
    println(`[Cookie采集] ${shopName}：未能读取 Cookie`);
    return;
  }
  if (detail.diagnostics) {
    logCookieDiagnostics(shopName, detail.diagnostics);
    return;
  }
  println(`[Cookie采集] ${shopName} 当前URL：${detail.pageUrl || 'unknown'}`);
  println(
    `[Cookie采集] ${shopName} 读取 Cookie 数量：${detail.cookieKeyCount}，长度：${detail.cookie?.length || 0}，包含 a1：${detail.hasA1}`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  ARK_TOKEN_KEY,
  WALLE_TOKEN_KEY,
  CRITICAL_COOKIE_NAMES,
  DEFAULT_NETWORK_HEADER_WAIT_MS,
  cookieContainsA1,
  cookieContainsArkToken,
  cookieContainsWalleToken,
  extractCookieValueByName,
  extractCookieKeys,
  mergeCookiePartsPreferLongest,
  mergeCdpCookieEntries,
  mergeBridgeNetworkHeaderCookies,
  isXhsRelatedRequestUrl,
  isArkRelatedRequestUrl,
  createNetworkHeaderCookieCollector,
  ensureBridgeNetworkHeaderListeners,
  collectFullCookiesFromBridge,
  logCookieCollectionDiagnostics,
  logCookieDiagnostics,
};
