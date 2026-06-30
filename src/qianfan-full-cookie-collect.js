/**
 * 千帆四店完整 Cookie 采集（Browser CDP + Page CDP 全量 + 多 URL 合并，确保含 a1）
 */
const CDP = require('chrome-remote-interface');
const { normalizeCookie, hashCookie } = require('./qianfan-cookie-collector');
const { fetchDevToolsVersion } = require('./devtools-list');
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
  'https://ark.xiaohongshu.com/app-order/order/query',
  'https://ark.xiaohongshu.com/app-seller/seller/home',
  'https://ark.xiaohongshu.com/app-review/review-manage',
];

const ARK_PROBE_FETCH_URLS = [
  'https://ark.xiaohongshu.com/api/edith/home/get_shop_score',
  'https://ark.xiaohongshu.com/api/edith/order/query/query_list?page=1&pageSize=1',
];

const ARK_PROBE_PAGE_URLS = [
  'https://ark.xiaohongshu.com/app-order/order/query',
  'https://ark.xiaohongshu.com/app-seller/seller/home',
];

const ARK_REQUEST_URL_HINTS = [
  'ark.xiaohongshu.com',
  '/api/ark/',
  '/api/edith/',
  '/api/order',
  '/app-order/',
  'app-seller',
];

function isXhsRelatedDomain(domain) {
  const d = String(domain || '').toLowerCase();
  return d.includes('xiaohongshu.com') || d.includes('xiaohongshu.net');
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
  return ARK_REQUEST_URL_HINTS.some((hint) => u.includes(hint));
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

async function ensureNetworkEnabled(client) {
  if (!client?.Network?.enable) return;
  try {
    await client.Network.enable({});
  } catch {
    // already enabled
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

async function readPageCdpCookies(client, pageUrl) {
  const sources = {
    getAllCookies: { count: 0, keys: [], cookie: '' },
    getCookiesByUrl: { count: 0, keys: [], cookie: '' },
  };
  const rawLists = [];
  await ensureNetworkEnabled(client);

  if (client.Network?.getAllCookies) {
    try {
      const all = await client.Network.getAllCookies();
      const list = all?.cookies || [];
      sources.getAllCookies.count = list.length;
      const merged = mergeCdpCookieEntries(list);
      sources.getAllCookies.keys = extractCookieKeys(merged.cookie);
      sources.getAllCookies.cookie = merged.cookie;
      if (list.length) rawLists.push(list);
    } catch {
      // ignore
    }
  }

  const urls = new Set(XHS_COOKIE_URLS);
  if (pageUrl) urls.add(String(pageUrl).split('#')[0]);
  const perUrlLists = [];
  if (client.Network?.getCookies) {
    for (const url of urls) {
      try {
        const one = await client.Network.getCookies({ urls: [url] });
        const list = one?.cookies || [];
        if (list.length) perUrlLists.push(list);
      } catch {
        // ignore per-url
      }
    }
  }
  if (perUrlLists.length) {
    const flat = perUrlLists.flat();
    sources.getCookiesByUrl.count = flat.length;
    const merged = mergeCdpCookieEntries(flat);
    sources.getCookiesByUrl.keys = extractCookieKeys(merged.cookie);
    sources.getCookiesByUrl.cookie = merged.cookie;
    rawLists.push(flat);
  }

  const merged = mergeCdpCookieEntries(rawLists.flat());
  return { cookie: merged.cookie, a1Meta: merged.a1Meta, sources };
}

async function readBrowserStorageCookies(browserContextId) {
  const qd = config.qianfanDebug || {};
  const port = qd.devtoolsPort || 9322;
  const host = qd.devtoolsHost || '127.0.0.1';
  const version = await fetchDevToolsVersion(port, host).catch(() => null);
  const browserWs = version?.webSocketDebuggerUrl;
  if (!browserWs) return { count: 0, keys: [], cookie: '', a1Meta: null };

  let browserClient;
  try {
    browserClient = await CDP({ target: browserWs });
    const params = browserContextId ? { browserContextId } : {};
    const result = await browserClient.Storage.getCookies(params);
    const list = result?.cookies || [];
    const merged = mergeCdpCookieEntries(list);
    return {
      count: list.length,
      keys: extractCookieKeys(merged.cookie),
      cookie: merged.cookie,
      a1Meta: merged.a1Meta,
      browserWs: browserWs.slice(0, 60),
    };
  } catch {
    return { count: 0, keys: [], cookie: '', a1Meta: null };
  } finally {
    if (browserClient) {
      try {
        await browserClient.close();
      } catch {
        // ignore
      }
    }
  }
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

function attachNetworkCookieSniffer(client) {
  const buckets = { ark: [], walle: [], order: [], any: [] };
  const pushCookieText = (cookie, url) => {
    if (!cookie) return;
    buckets.any.push(cookie);
    if (isArkRelatedRequestUrl(url) || cookieContainsArkToken(cookie)) buckets.ark.push(cookie);
    else if (String(url).includes('walle.xiaohongshu.com') || cookieContainsWalleToken(cookie)) buckets.walle.push(cookie);
    else if (/\/api\/(order|ark|edith)/i.test(String(url))) buckets.order.push(cookie);
  };
  const onRequest = (params) => {
    const url = String(params?.request?.url || '');
    const cookie = String(params?.request?.headers?.Cookie || params?.request?.headers?.cookie || '').trim();
    pushCookieText(cookie, url);
  };
  const onExtra = (params) => {
    const url = String(params?.request?.url || params?.url || '');
    const cookie = String(params?.headers?.Cookie || params?.headers?.cookie || '').trim();
    pushCookieText(cookie, url);
  };
  const onResponse = (params) => {
    const url = String(params?.response?.url || '');
    if (!isArkRelatedRequestUrl(url) && !/\/api\/(order|ark|edith)/i.test(url)) return;
    const headers = params?.response?.headers || {};
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() !== 'set-cookie') continue;
      const pairs = parseSetCookieHeader(value);
      if (pairs.length) pushCookieText(pairs.join('; '), url);
    }
  };
  try {
    client.Network.requestWillBeSent(onRequest);
  } catch {
    // ignore
  }
  try {
    if (client.Network.requestWillBeSentExtraInfo) {
      client.Network.requestWillBeSentExtraInfo(onExtra);
    }
  } catch {
    // ignore
  }
  try {
    client.Network.responseReceived(onResponse);
  } catch {
    // ignore
  }
  return {
    mergeSniffed() {
      return mergeCookiePartsPreferLongest(...buckets.ark, ...buckets.walle, ...buckets.order, ...buckets.any);
    },
    stats() {
      return {
        arkRequests: buckets.ark.length,
        walleRequests: buckets.walle.length,
        orderRequests: buckets.order.length,
        anyRequests: buckets.any.length,
      };
    },
  };
}

async function probeArkTokenViaPage(client, pageUrl) {
  const chunks = [];
  await ensureNetworkEnabled(client);

  if (client.Runtime?.evaluate) {
    const fetchUrls = ARK_PROBE_FETCH_URLS.map((u) => JSON.stringify(u)).join(',');
    try {
      await client.Runtime.evaluate({
        expression: `(async()=>{ const urls=[${fetchUrls}]; for (const u of urls){ try{ await fetch(u,{credentials:'include',mode:'cors',headers:{accept:'application/json, text/plain, */*',referer:'https://ark.xiaohongshu.com/app-order/order/query'}});}catch(e){} await new Promise(r=>setTimeout(r,400)); } return true; })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      await sleep(2500);
      const afterFetch = await readPageCdpCookies(client, pageUrl);
      if (afterFetch.cookie) chunks.push(afterFetch.cookie);
    } catch {
      // ignore fetch probe
    }
  }

  if (!chunks.some(cookieContainsArkToken) && client.Page?.navigate) {
    const origin = String(pageUrl || '').split('#')[0];
    for (const arkUrl of ARK_PROBE_PAGE_URLS) {
      try {
        println(`[Cookie采集] 尝试打开 ark 页面以获取 access-token-ark：${arkUrl}`);
        await client.Page.navigate({ url: arkUrl });
        await sleep(3500);
        const afterNav = await readPageCdpCookies(client, arkUrl);
        if (afterNav.cookie) chunks.push(afterNav.cookie);
        if (cookieContainsArkToken(afterNav.cookie)) break;
      } catch {
        // ignore per-url
      }
    }
    if (origin) {
      try {
        await client.Page.navigate({ url: origin });
        await sleep(800);
      } catch {
        // ignore restore
      }
    }
  }

  return mergeCookiePartsPreferLongest(...chunks);
}

function logCookieDiagnostics(shopName, diag) {
  println(`[Cookie诊断] ${shopName}`);
  if (diag.pageTitle) println(`[Cookie诊断] pageTitle=${diag.pageTitle}`);
  if (diag.url) println(`[Cookie诊断] url=${diag.url}`);
  if (diag.targetId) println(`[Cookie诊断] targetId=${diag.targetId}`);
  if (diag.browserContextId) println(`[Cookie诊断] browserContextId=${diag.browserContextId}`);
  if (diag.sessionPartition) println(`[Cookie诊断] session/partition=${diag.sessionPartition}`);

  for (const src of diag.sources || []) {
    println(
      `[Cookie诊断] ${src.label} count=${src.count} length=${src.length} containsA1=${src.containsA1} keys=${src.keys.join(',') || '(none)'}`
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
  if (diag.a1Meta) {
    println(
      `[Cookie诊断] a1 meta domain=${diag.a1Meta.domain} path=${diag.a1Meta.path} httpOnly=${diag.a1Meta.httpOnly} secure=${diag.a1Meta.secure} sameSite=${diag.a1Meta.sameSite || '-'}`
    );
  }
  if (diag.networkSniff) {
    println(
      `[Cookie诊断] networkSniff ark=${diag.networkSniff.arkRequests || 0} walle=${diag.networkSniff.walleRequests || 0} order=${diag.networkSniff.orderRequests || 0}`
    );
  }
  if (diag.payloadContainsA1 != null) {
    println(`[Cookie诊断] payload cookie containsA1=${diag.payloadContainsA1}`);
  }
  if (diag.payloadContainsArkToken != null) {
    println(`[Cookie诊断] payload cookie containsArkToken=${diag.payloadContainsArkToken}`);
  }
  if (!diag.containsA1) {
    println(
      `[Cookie诊断] ${shopName} 缺少 a1，当前 CDP 页面没有读到完整小红书登录 Cookie`
    );
    println(
      `[Cookie诊断] 提示：请在同一个 Chrome 窗口打开 https://www.xiaohongshu.com 确认已登录，再打开对应商家后台/千帆页面后重新提交`
    );
  } else if (!diag.containsArkToken) {
    println(
      `[Cookie诊断] ${shopName} 缺少 access-token-ark.xiaohongshu.com，请打开该店商家后台「订单/数据/经营」页面后重新提交 Cookie`
    );
    println(
      `[Cookie诊断] 建议：在千帆工作台点击「订单管理」或打开 https://ark.xiaohongshu.com/app-order/order/query 后再提交`
    );
  }
}

async function collectFullCookiesFromBridge(bridge, options = {}) {
  if (!bridge?.client) return null;
  const client = bridge.client;
  const pageUrl = String(bridge.pageInfo?.url || bridge.lastSeenUrl || 'https://walle.xiaohongshu.com').trim();
  const pageTitle = String(bridge.pageInfo?.pageTitle || bridge.pageInfo?.title || bridge.shopTitle || '').trim();
  const headerCookie = normalizeCookie(bridge.lastRequestCookie || '');
  const arkHeaderCookie = normalizeCookie(bridge.lastArkRequestCookie || bridge.lastOrderRequestCookie || '');
  const walleHeaderCookie = normalizeCookie(bridge.lastWalleRequestCookie || '');
  const targetMeta = await getPageTargetMeta(client);
  const sniffer = attachNetworkCookieSniffer(client);

  let pageCdp = await readPageCdpCookies(client, pageUrl);
  let browserStorage = await readBrowserStorageCookies(targetMeta.browserContextId);
  let pageCookies = await readPageDocumentCookie(client);
  let probeCookie = '';

  if (!cookieContainsA1(pageCdp.cookie) && !cookieContainsA1(browserStorage.cookie) && options.retryReload !== false && client.Page?.reload) {
    try {
      println(`[Cookie采集] ${bridge.shopTitle || '店铺'} 缺少 a1，尝试刷新页面后重采…`);
      await client.Page.reload({ ignoreCache: false });
      await sleep(3000);
      pageCdp = await readPageCdpCookies(client, pageUrl);
      browserStorage = await readBrowserStorageCookies(targetMeta.browserContextId);
      pageCookies = await readPageDocumentCookie(client);
    } catch {
      // ignore reload errors
    }
  }

  let mergedSoFar = mergeCookiePartsPreferLongest(
    pageCdp.cookie,
    browserStorage.cookie,
    pageCookies,
    headerCookie,
    arkHeaderCookie,
    walleHeaderCookie,
    sniffer.mergeSniffed()
  );

  if (cookieContainsA1(mergedSoFar) && !cookieContainsArkToken(mergedSoFar) && options.probeArk !== false) {
    probeCookie = await probeArkTokenViaPage(client, pageUrl);
    await sleep(1000);
    pageCdp = await readPageCdpCookies(client, pageUrl);
    browserStorage = await readBrowserStorageCookies(targetMeta.browserContextId);
  }

  const sniffedAfter = sniffer.mergeSniffed();
  const beforeParts = [
    pageCdp.cookie,
    browserStorage.cookie,
    pageCookies,
    headerCookie,
    arkHeaderCookie,
    walleHeaderCookie,
    sniffedAfter,
    probeCookie,
  ].filter(Boolean);
  const beforeMergeKeys = [...new Set(beforeParts.flatMap((p) => extractCookieKeys(p)))].sort();

  const cookie = mergeCookiePartsPreferLongest(...beforeParts);
  const afterMergeKeys = extractCookieKeys(cookie);
  const hasA1 = cookieContainsA1(cookie);
  const hasArk = cookieContainsArkToken(cookie);
  const hasWalle = cookieContainsWalleToken(cookie);
  const a1Meta = pageCdp.a1Meta || browserStorage.a1Meta || null;
  const networkSniff = sniffer.stats();

  const diagnostics = {
    shopName: bridge.shopTitle || '',
    pageTitle,
    url: pageUrl,
    targetId: targetMeta.targetId || bridge.pageInfo?.targetId || '',
    browserContextId: targetMeta.browserContextId || '',
    sessionPartition: bridge.pageInfo?.sessionPartition || '',
    sources: [
      buildSourceDiag('getAllCookies', pageCdp.sources.getAllCookies.cookie, {
        count: pageCdp.sources.getAllCookies.count,
      }),
      buildSourceDiag('getCookies(multi-url)', pageCdp.sources.getCookiesByUrl.cookie, {
        count: pageCdp.sources.getCookiesByUrl.count,
      }),
      buildSourceDiag('Storage.getCookies(browser)', browserStorage.cookie, {
        count: browserStorage.count,
      }),
      buildSourceDiag('lastRequestCookie', headerCookie),
      buildSourceDiag('lastArkRequestCookie', arkHeaderCookie),
      buildSourceDiag('lastWalleRequestCookie', walleHeaderCookie),
      buildSourceDiag('networkSniff', sniffedAfter, networkSniff),
      buildSourceDiag('arkProbe', probeCookie),
      buildSourceDiag('document.cookie(ref)', pageCookies),
    ],
    beforeMergeKeys,
    afterMergeKeys,
    mergedCount: afterMergeKeys.length,
    mergedLength: cookie.length,
    containsA1: hasA1,
    containsArkToken: hasArk,
    containsWalleToken: hasWalle,
    networkSniff,
    a1Meta,
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
      cdpLength: pageCdp.cookie.length,
      browserLength: browserStorage.cookie.length,
      pageLength: pageCookies.length,
      headerLength: headerCookie.length,
      arkHeaderLength: arkHeaderCookie.length,
      probeLength: probeCookie.length,
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
  if (detail.cookieKeys?.length) {
    println(`[Cookie采集] ${shopName} Cookie keys：${detail.cookieKeys.join(', ')}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  ARK_TOKEN_KEY,
  WALLE_TOKEN_KEY,
  CRITICAL_COOKIE_NAMES,
  XHS_COOKIE_URLS,
  ARK_PROBE_PAGE_URLS,
  cookieContainsA1,
  cookieContainsArkToken,
  cookieContainsWalleToken,
  extractCookieValueByName,
  extractCookieKeys,
  mergeCookiePartsPreferLongest,
  mergeCdpCookieEntries,
  collectFullCookiesFromBridge,
  logCookieCollectionDiagnostics,
  logCookieDiagnostics,
  isArkRelatedRequestUrl,
};
