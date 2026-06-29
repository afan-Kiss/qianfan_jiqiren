/**
 * 千帆 Cookie 自动采集并上传到珠宝项目总控台
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./wechat/wxbot-new-config');
const { readJson, writeJson } = require('./shared/safe-json-store');
const { findBridgeByShopTitle, listRegisteredShops } = require('./qianfan-ws-bridge');
const { println } = require('./utils');

const ROOT = config.root || process.cwd();
const STATE_FILE = path.join(ROOT, 'data', 'qianfan-cookie-state.json');
const SHOPS_CONFIG = path.join(ROOT, 'config', 'qianfan-shops.json');
const UPLOAD_INTERVAL_MS = 10 * 60 * 1000;
const FALLBACK_INTERVAL_MS = 10 * 60 * 1000;
const CHECK_DEBOUNCE_MS = 5000;

const QIANFAN_COOKIE_DOMAINS = [
  'xiaohongshu.com',
  'edith.xiaohongshu.com',
  'walle.xiaohongshu.com',
  'ark.xiaohongshu.com',
];

let refreshTimer = null;
let shopsMappingCache = null;
const pendingChecks = new Map();
const loginRecoveredShops = new Set();

function getControlConfig() {
  const cc = config.controlCenter || {};
  const serverUrl = String(
    process.env.CONTROL_SERVER_URL || cc.serverUrl || 'http://8.137.126.18/control'
  ).replace(/\/$/, '');
  const serviceToken = String(process.env.CONTROL_SERVICE_TOKEN || cc.serviceToken || '').trim();
  return {
    enabled: cc.enabled !== false && Boolean(serviceToken),
    serverUrl,
    serviceToken,
    collectorMachine: String(process.env.CONTROL_COLLECTOR_MACHINE || cc.collectorMachine || '培育钻石').trim(),
    collectorProject: String(cc.collectorProject || '千帆中转机器人').trim(),
    uploadIntervalMinutes: Number(cc.uploadIntervalMinutes || 10),
  };
}

function loadShopsMapping() {
  if (shopsMappingCache) return shopsMappingCache;
  try {
    if (fs.existsSync(SHOPS_CONFIG)) {
      const raw = JSON.parse(fs.readFileSync(SHOPS_CONFIG, 'utf8'));
      shopsMappingCache = Array.isArray(raw) ? raw : [];
      return shopsMappingCache;
    }
  } catch {
    // ignore
  }
  shopsMappingCache = [];
  return shopsMappingCache;
}

function loadState() {
  const raw = readJson(STATE_FILE, { shops: {} }, { critical: false });
  if (!raw || typeof raw !== 'object') return { shops: {} };
  if (!raw.shops || typeof raw.shops !== 'object') raw.shops = {};
  return raw;
}

function saveState(state) {
  writeJson(STATE_FILE, state, { critical: false });
}

function hashPrefix(hash) {
  return String(hash || '').slice(0, 8);
}

function hashCookie(normalized) {
  const value = normalizeCookie(normalized);
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function normalizeCookie(input) {
  if (!input) return '';
  if (typeof input === 'string') {
    const map = new Map();
    for (const seg of input.split(';')) {
      const piece = seg.trim();
      if (!piece) continue;
      const eq = piece.indexOf('=');
      if (eq <= 0) continue;
      map.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  if (Array.isArray(input)) {
    const pairs = input
      .map((c) => {
        const name = String(c?.name || '').trim();
        const value = String(c?.value ?? '').trim();
        if (!name) return '';
        return `${name}=${value}`;
      })
      .filter(Boolean);
    return normalizeCookie(pairs.join('; '));
  }
  return '';
}

function cookiesFromCdpList(list) {
  if (!Array.isArray(list)) return '';
  const filtered = list.filter((c) => {
    const domain = String(c?.domain || '').toLowerCase();
    return QIANFAN_COOKIE_DOMAINS.some((d) => domain.includes(d.replace(/^\./, '')));
  });
  return normalizeCookie(filtered);
}

function mergeCookieStrings(...parts) {
  const map = new Map();
  for (const part of parts) {
    for (const seg of String(part || '').split(';')) {
      const piece = seg.trim();
      if (!piece) continue;
      const eq = piece.indexOf('=');
      if (eq <= 0) continue;
      map.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
    }
  }
  return normalizeCookie([...map.entries()].map(([k, v]) => `${k}=${v}`).join('; '));
}

function detectShopFromQianfanContext(pageInfo = {}, extra = {}) {
  const mappings = loadShopsMapping();
  const shopTitle = String(pageInfo.shopTitle || extra.shopTitle || '').trim();
  const url = String(pageInfo.url || extra.lastSeenUrl || '').trim();
  const pageTitle = String(pageInfo.pageTitle || pageInfo.title || '').trim();
  const accountName = String(extra.accountName || '').trim();

  let shopId = String(extra.shopId || '').trim();
  try {
    const u = new URL(url);
    for (const key of ['shopId', 'sellerId', 'storeId']) {
      const v = u.searchParams.get(key);
      if (v) {
        shopId = v;
        break;
      }
    }
  } catch {
    // ignore
  }

  for (const row of mappings) {
    const name = String(row.shopName || '').trim();
    if (!name) continue;
    const urlKw = String(row.matchUrlKeyword || '').trim();
    const accKw = String(row.accountKeyword || '').trim();
    const titleKw = String(row.matchTitleKeyword || '').trim();
    const matchedByName = shopTitle && (shopTitle === name || shopTitle.includes(name));
    const matchedByUrl = urlKw && url.includes(urlKw);
    const matchedByAcc = accKw && accountName.includes(accKw);
    const matchedByTitle = titleKw && pageTitle.includes(titleKw);
    if (matchedByName || matchedByUrl || matchedByAcc || matchedByTitle) {
      return {
        shopName: name,
        shopId: String(row.shopId || shopId || '').trim(),
        accountName: accountName || String(row.accountKeyword || '').trim(),
        lastSeenUrl: url,
        pageTitle,
        matchedBy: matchedByName ? 'shopTitle' : matchedByUrl ? 'url' : matchedByAcc ? 'account' : 'title',
      };
    }
  }

  const fallbackName = shopTitle || '未识别店铺';
  return {
    shopName: fallbackName,
    shopId,
    accountName,
    lastSeenUrl: url,
    pageTitle,
    matchedBy: shopTitle ? 'pageTitle' : 'unknown',
  };
}

async function collectCookiesFromBridge(bridge) {
  if (!bridge?.client) return '';
  const client = bridge.client;
  const pageUrl = String(bridge.pageInfo?.url || 'https://walle.xiaohongshu.com').trim();
  let cdpCookies = '';
  let pageCookies = '';

  try {
    if (client.Network?.getAllCookies) {
      const all = await client.Network.getAllCookies();
      cdpCookies = cookiesFromCdpList(all?.cookies);
    } else if (client.Network?.getCookies) {
      const one = await client.Network.getCookies({ urls: [pageUrl] });
      cdpCookies = cookiesFromCdpList(one?.cookies);
    }
  } catch {
    // ignore CDP cookie read errors
  }

  try {
    if (client.Runtime?.evaluate) {
      const evalRes = await client.Runtime.evaluate({
        expression: 'document.cookie || ""',
        returnByValue: true,
      });
      pageCookies = normalizeCookie(evalRes?.result?.value || '');
    }
  } catch {
    // ignore
  }

  const headerCookie = normalizeCookie(bridge.lastRequestCookie || '');
  return mergeCookieStrings(cdpCookies, pageCookies, headerCookie);
}

async function collectQianfanCookies(bridgeOrContext) {
  const bridge =
    bridgeOrContext?.client && bridgeOrContext?.pageInfo
      ? bridgeOrContext
      : findBridgeByShopTitle(bridgeOrContext?.shopTitle || bridgeOrContext);
  if (!bridge) return null;

  const cookie = await collectCookiesFromBridge(bridge);
  if (!cookie || cookie.length < 20) return null;

  const shopCtx = detectShopFromQianfanContext(bridge.pageInfo || {}, {
    shopTitle: bridge.shopTitle,
    lastSeenUrl: bridge.pageInfo?.url,
  });
  const cookieHash = hashCookie(cookie);
  const capturedAt = new Date().toISOString();

  return {
    platform: 'qianfan',
    shopName: shopCtx.shopName,
    shopId: shopCtx.shopId,
    accountName: shopCtx.accountName,
    cookie,
    cookieHash,
    source: 'qianfan-relay-cdp',
    lastSeenUrl: shopCtx.lastSeenUrl,
    capturedAt,
    matchedBy: shopCtx.matchedBy,
  };
}

function shouldUploadCookie(stateEntry, collected, options = {}) {
  if (!collected?.cookieHash) return { upload: false, reason: 'empty' };
  if (options.force) return { upload: true, reason: 'forced' };
  if (options.loginRecovered) return { upload: true, reason: 'login_recovered' };
  if (!stateEntry) return { upload: true, reason: 'first_collect' };
  if (stateEntry.lastUploadStatus === 'failed') return { upload: true, reason: 'retry_failed' };
  if (stateEntry.shopName && collected.shopName && stateEntry.shopName !== collected.shopName) {
    return { upload: true, reason: 'shop_name_changed' };
  }
  if (stateEntry.shopId && collected.shopId && stateEntry.shopId !== collected.shopId) {
    return { upload: true, reason: 'shop_id_changed' };
  }
  if (stateEntry.cookieHash !== collected.cookieHash) {
    return { upload: true, reason: 'hash_changed' };
  }
  const lastUploadedAt = stateEntry.lastUploadedAt ? Date.parse(stateEntry.lastUploadedAt) : 0;
  if (!lastUploadedAt || Date.now() - lastUploadedAt >= UPLOAD_INTERVAL_MS) {
    return { upload: true, reason: 'interval_refresh' };
  }
  return { upload: false, reason: 'unchanged' };
}

async function uploadCookieToControlCenter(collected) {
  const cc = getControlConfig();
  if (!cc.enabled) {
    return { ok: false, skipped: true, reason: 'control_center_disabled' };
  }

  const url = `${cc.serverUrl}/api/secrets/qianfan/upload-cookie`;
  const body = {
    platform: 'qianfan',
    shopName: collected.shopName,
    shopId: collected.shopId || undefined,
    accountName: collected.accountName || undefined,
    cookie: collected.cookie,
    cookieHash: collected.cookieHash,
    source: collected.source || 'qianfan-relay-cdp',
    collectorMachine: cc.collectorMachine,
    collectorProject: cc.collectorProject,
    lastSeenUrl: collected.lastSeenUrl,
    capturedAt: collected.capturedAt,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cc.serviceToken}`,
      'x-service-token': cc.serviceToken,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, status: res.status, error: data.error || `HTTP ${res.status}` };
  }
  return { ok: true, data };
}

function handleCookieUploadResult(result, state, shopKey, collected) {
  const entry = state.shops[shopKey] || {};
  entry.shopName = collected.shopName;
  entry.shopId = collected.shopId || entry.shopId || '';
  entry.cookieHash = collected.cookieHash;
  entry.lastCollectedAt = collected.capturedAt;
  if (result.ok) {
    entry.lastUploadedAt = new Date().toISOString();
    entry.lastUploadStatus = result.data?.unchanged ? 'unchanged' : 'ok';
  } else if (result.skipped) {
    entry.lastUploadStatus = 'skipped';
  } else {
    entry.lastUploadStatus = 'failed';
    entry.lastUploadError = String(result.error || 'unknown').slice(0, 120);
  }
  state.shops[shopKey] = entry;
  saveState(state);
  return entry;
}

async function runCookieCheckForShop(shopTitle, reason = 'manual') {
  const cc = getControlConfig();
  if (!cc.enabled) return { skipped: true, reason: 'disabled' };

  const bridge = findBridgeByShopTitle(shopTitle);
  if (!bridge) return { skipped: true, reason: 'no_bridge' };

  const collected = await collectQianfanCookies(bridge);
  if (!collected) return { skipped: true, reason: 'no_cookie' };

  const state = loadState();
  const shopKey = collected.shopName || shopTitle;
  const prev = state.shops[shopKey];
  const loginRecovered = loginRecoveredShops.has(shopKey);
  const decision = shouldUploadCookie(prev, collected, { loginRecovered });

  state.shops[shopKey] = {
    ...(prev || {}),
    shopName: collected.shopName,
    shopId: collected.shopId || prev?.shopId || '',
    cookieHash: collected.cookieHash,
    lastCollectedAt: collected.capturedAt,
    lastCheckReason: reason,
  };
  saveState(state);

  if (!decision.upload) {
    return { skipped: true, reason: decision.reason, shopName: collected.shopName };
  }

  println(
    `检测到千帆 Cookie，店铺：${collected.shopName}，hash：${hashPrefix(collected.cookieHash)}，准备上传到总控台。`
  );

  let result;
  try {
    result = await uploadCookieToControlCenter(collected);
  } catch (err) {
    result = { ok: false, error: err.message || String(err) };
  }

  handleCookieUploadResult(result, state, shopKey, collected);
  loginRecoveredShops.delete(shopKey);

  if (result.ok) {
    const msg =
      result.data?.unchanged
        ? `千帆 Cookie 没变化，只刷新了在线时间，店铺：${collected.shopName}。`
        : `千帆 Cookie 已自动更新到总控台，店铺：${collected.shopName}。`;
    println(msg);
    return { ok: true, unchanged: Boolean(result.data?.unchanged), shopName: collected.shopName };
  }

  println('千帆 Cookie 上传失败，不影响当前机器人运行，将稍后重试。');
  return { ok: false, error: result.error, shopName: collected.shopName };
}

function triggerCookieCheck(shopTitle, reason = 'event') {
  if (!shopTitle) return Promise.resolve({ skipped: true });
  const cc = getControlConfig();
  if (!cc.enabled) return Promise.resolve({ skipped: true });

  const key = String(shopTitle);
  const prev = pendingChecks.get(key);
  if (prev) return prev;

  const task = new Promise((resolve) => {
    setTimeout(() => {
      pendingChecks.delete(key);
      void runCookieCheckForShop(key, reason).then(resolve).catch((err) => {
        resolve({ ok: false, error: err.message || String(err) });
      });
    }, CHECK_DEBOUNCE_MS);
  });
  pendingChecks.set(key, task);
  return task;
}

async function runFallbackCheckAll() {
  const shops = listRegisteredShops().filter((s) => s && !s.startsWith('__'));
  for (const shop of shops) {
    await triggerCookieCheck(shop, 'interval');
  }
}

function scheduleCookieRefresh() {
  const cc = getControlConfig();
  if (!cc.enabled) {
    println('[Cookie] 总控台上传未启用（缺少 CONTROL_SERVICE_TOKEN）');
    return;
  }
  if (refreshTimer) clearInterval(refreshTimer);
  const intervalMs = Math.max(60000, (cc.uploadIntervalMinutes || 10) * 60 * 1000);
  refreshTimer = setInterval(() => {
    void runFallbackCheckAll();
  }, intervalMs);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  println(`[Cookie] 已启动 ${cc.uploadIntervalMinutes || 10} 分钟兜底检查`);
}

function onBridgeRegistered(bridge) {
  const shopTitle = bridge?.shopTitle;
  if (!shopTitle) return;
  void triggerCookieCheck(shopTitle, 'bridge_registered');
}

function onWsConnected(shopTitle) {
  void triggerCookieCheck(shopTitle, 'ws_connected');
}

function onBuyerMessage(message) {
  const shopTitle = message?.shopTitle;
  if (!shopTitle) return;
  void triggerCookieCheck(shopTitle, 'buyer_message');
}

function onAuthError(shopTitle) {
  loginRecoveredShops.add(String(shopTitle));
  void triggerCookieCheck(shopTitle, 'auth_error');
}

function onShopSwitch(shopTitle) {
  void triggerCookieCheck(shopTitle, 'shop_switch');
}

function noteBridgeRequestCookie(bridge, cookieHeader) {
  const raw = String(cookieHeader || '').trim();
  if (!raw || !bridge) return;
  if (!bridge.lastRequestCookie || raw.length >= bridge.lastRequestCookie.length) {
    bridge.lastRequestCookie = raw;
    bridge.lastCookieCapturedAt = Date.now();
  }
}

module.exports = {
  getControlConfig,
  hashCookie,
  hashPrefix,
  normalizeCookie,
  detectShopFromQianfanContext,
  collectQianfanCookies,
  shouldUploadCookie,
  uploadCookieToControlCenter,
  handleCookieUploadResult,
  scheduleCookieRefresh,
  triggerCookieCheck,
  onBridgeRegistered,
  onWsConnected,
  onBuyerMessage,
  onAuthError,
  onShopSwitch,
  noteBridgeRequestCookie,
  loadState,
};
