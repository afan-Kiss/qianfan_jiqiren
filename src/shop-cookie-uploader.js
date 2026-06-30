/**
 * 四店 Cookie 批量上传到主播分析系统 /api/shop-cookies（Token 可选）
 */
const CDP = require('chrome-remote-interface');
const config = require('./wechat/wxbot-new-config');
const { fetchDevToolsJsonList, getPageTargets } = require('./devtools-list');
const { detectQianfanShopPages } = require('./page-finder');
const { registerQianfanWsBridge, findBridgeByShopTitle } = require('./qianfan-ws-bridge');
const { collectQianfanCookies, hashPrefix } = require('./qianfan-cookie-collector');
const { fetchWithTimeout } = require('./fetch-timeout');
const { println } = require('./utils');

const CANONICAL_SHOPS = [
  { shopKey: 'xiangyu', shopName: '祥钰珠宝', matchNames: ['祥钰珠宝'] },
  { shopKey: 'xyxiangyu', shopName: 'XY祥钰珠宝', matchNames: ['XY祥钰珠宝', 'XY祥钰', 'xy祥钰'] },
  { shopKey: 'hetianyayu', shopName: '和田雅玉', matchNames: ['和田雅玉'] },
  { shopKey: 'shiyuju', shopName: '拾玉居', matchNames: ['拾玉居', '拾玉居和田玉'] },
];

const SHOP_KEY_BY_NAME = {};
const SHOP_NAME_BY_KEY = {};
for (const row of CANONICAL_SHOPS) {
  SHOP_NAME_BY_KEY[row.shopKey] = row.shopName;
  for (const name of row.matchNames) {
    SHOP_KEY_BY_NAME[name] = row.shopKey;
  }
  SHOP_KEY_BY_NAME[row.shopName] = row.shopKey;
}

const ACCEPTABLE_SERVER_STATUSES = new Set([
  'uploaded',
  'pending_validate',
  'valid',
  'unknown',
]);

const BUYER_MESSAGE_DEBOUNCE_MS = 5000;
const UPLOAD_TIMEOUT_MS = 20000;

let pendingBuyerUpload = null;

function getShopCookieUploadConfig() {
  const sc = config.shopCookieUpload || {};
  const serverUrl = String(
    process.env.SHOP_COOKIE_UPLOAD_URL || sc.serverUrl || 'http://8.137.126.18'
  ).replace(/\/$/, '');
  const uploadToken = String(process.env.SHOP_COOKIE_UPLOAD_TOKEN || sc.uploadToken || '').trim();
  const uploadPath = String(sc.uploadPath || '/api/shop-cookies/update').trim() || '/api/shop-cookies/update';
  const statusPath = String(sc.statusPath || '/api/shop-cookies/status').trim() || '/api/shop-cookies/status';
  return {
    enabled: sc.enabled !== false,
    serverUrl,
    uploadPath: uploadPath.startsWith('/') ? uploadPath : `/${uploadPath}`,
    statusPath: statusPath.startsWith('/') ? statusPath : `/${statusPath}`,
    uploadToken,
    timeoutMs: Number(process.env.SHOP_COOKIE_UPLOAD_TIMEOUT_MS || sc.timeoutMs || UPLOAD_TIMEOUT_MS),
  };
}

function shopDisplayName(shopKey) {
  return SHOP_NAME_BY_KEY[shopKey] || shopKey;
}

function maskCookiePreview(cookie) {
  const text = String(cookie || '').trim();
  if (!text) return '';
  if (text.length <= 20) return `${text.slice(0, 4)}...${text.slice(-4)}`;
  return `${text.slice(0, 8)}...${text.slice(-8)}`;
}

function buildAuthHeaders(uploadCfg) {
  const headers = { 'Content-Type': 'application/json' };
  if (uploadCfg.uploadToken) {
    headers.Authorization = `Bearer ${uploadCfg.uploadToken}`;
    headers['X-Shop-Cookie-Token'] = uploadCfg.uploadToken;
    headers['X-Shop-Cookie-Upload-Token'] = uploadCfg.uploadToken;
  }
  return headers;
}

function buildAuthHeadersGet(uploadCfg) {
  const headers = {};
  if (uploadCfg.uploadToken) {
    headers.Authorization = `Bearer ${uploadCfg.uploadToken}`;
    headers['X-Shop-Cookie-Token'] = uploadCfg.uploadToken;
    headers['X-Shop-Cookie-Upload-Token'] = uploadCfg.uploadToken;
  }
  return headers;
}

function logUploadConfig(uploadCfg) {
  println(`[Cookie上传] 已启用，服务器：${uploadCfg.serverUrl}`);
  println(`[Cookie上传] 上传接口：${uploadCfg.uploadPath}，状态接口：${uploadCfg.statusPath}`);
  if (uploadCfg.uploadToken) {
    println('[Cookie上传] 已配置 Token，将随请求附带（可选兼容）');
  } else {
    println('[Cookie上传] 不使用 Token，直接提交');
  }
}

function buildShopResult(shopKey, partial = {}) {
  return {
    shopKey,
    shopName: partial.shopName || shopDisplayName(shopKey),
    ok: Boolean(partial.ok),
    hash8: partial.hash8 || '',
    length: partial.length || 0,
    cookiePreview: partial.cookiePreview || '',
    serverStatus: partial.serverStatus || '',
    lastUploadAt: partial.lastUploadAt || '',
    message: partial.message || '',
  };
}

function matchPageToShop(pageTitle) {
  const title = String(pageTitle || '').trim();
  if (!title) return null;
  const lower = title.toLowerCase();
  for (const row of CANONICAL_SHOPS) {
    for (const name of row.matchNames) {
      if (title === name || title.includes(name) || name.includes(title)) {
        return row;
      }
    }
  }
  if (lower.includes('xy') && (lower.includes('祥钰') || lower.includes('xiangyu'))) {
    return CANONICAL_SHOPS.find((s) => s.shopKey === 'xyxiangyu') || null;
  }
  return null;
}

async function collectFromBridge(shopRow) {
  for (const name of shopRow.matchNames) {
    const bridge = findBridgeByShopTitle(name);
    if (!bridge) continue;
    const collected = await collectQianfanCookies(bridge);
    if (collected?.cookie) return collected;
  }
  return null;
}

async function collectFromDevToolsForShops(missingRows = []) {
  const qd = config.qianfanDebug || {};
  const port = qd.devtoolsPort || 9322;
  const host = qd.devtoolsHost || '127.0.0.1';
  const list = await fetchDevToolsJsonList(port, host);
  const report = detectQianfanShopPages(getPageTargets(list), {
    expectedShopCount: qd.expectedShopCount || 4,
  });
  const targets = new Set(missingRows.map((r) => r.shopKey));
  const out = new Map();

  for (const page of report.shops || []) {
    const pageTitle = String(page.shopTitle || page.pageTitle || '').trim();
    const matched = matchPageToShop(pageTitle);
    if (!matched || !targets.has(matched.shopKey) || out.has(matched.shopKey)) continue;

    let client;
    try {
      client = await CDP({ target: page.webSocketDebuggerUrl });
      const bridge = await registerQianfanWsBridge(page, client);
      const collected = await collectQianfanCookies(bridge);
      if (collected?.cookie) out.set(matched.shopKey, collected);
    } catch {
      // ignore per-page CDP failures
    } finally {
      if (client) {
        try {
          await client.close();
        } catch {
          // ignore
        }
      }
    }
  }
  return out;
}

async function collectAllShopCookies(options = {}) {
  const collectedByKey = {};
  const missing = [];
  const useDevToolsFallback = options.useDevToolsFallback !== false;

  for (const row of CANONICAL_SHOPS) {
    const collected = await collectFromBridge(row);
    if (collected?.cookie) {
      collectedByKey[row.shopKey] = collected;
      println(
        `[Cookie上传] ${row.shopName}：已采集，长度 ${collected.cookie.length}，预览 ${maskCookiePreview(collected.cookie)}`
      );
      continue;
    }
    missing.push(row);
  }

  if (missing.length && useDevToolsFallback) {
    const cdpMap = await collectFromDevToolsForShops(missing);
    for (const row of [...missing]) {
      const collected = cdpMap.get(row.shopKey);
      if (!collected?.cookie) continue;
      collectedByKey[row.shopKey] = collected;
      println(
        `[Cookie上传] ${row.shopName}：已采集（CDP），长度 ${collected.cookie.length}，预览 ${maskCookiePreview(collected.cookie)}`
      );
      const idx = missing.findIndex((m) => m.shopKey === row.shopKey);
      if (idx >= 0) missing.splice(idx, 1);
    }
  }

  return {
    collectedByKey,
    missing: missing.map((r) => r.shopName),
    count: Object.keys(collectedByKey).length,
  };
}

function unwrapApiData(payload) {
  if (payload?.data && typeof payload.data === 'object') return payload.data;
  return payload;
}

function normalizeStatusEntries(data) {
  const raw = unwrapApiData(data);
  const entries = [];
  const shops = raw?.shops ?? raw?.shopsByKey ?? raw?.results ?? raw?.status;
  if (Array.isArray(shops)) {
    for (const row of shops) {
      if (row && typeof row === 'object') entries.push(row);
    }
    return entries;
  }
  if (shops && typeof shops === 'object') {
    for (const [key, row] of Object.entries(shops)) {
      if (row && typeof row === 'object') {
        entries.push({ shopKey: row.shopKey || key, ...row });
      }
    }
  }
  return entries;
}

function formatServerStatusLabel(status, reason) {
  const s = String(status || '').toLowerCase();
  if (s === 'valid') return '有效';
  if (s === 'invalid') return '验证失败';
  if (s === 'pending_validate') return '待验证';
  if (s === 'uploaded') return '已上传';
  if (s === 'unknown') return reason ? String(reason) : '待验证';
  return reason ? String(reason) : status ? String(status) : '未知';
}

function isServerReceived(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.hasCookie === true || row.configured === true || row.success === true) return true;
  const status = String(row.status || '').toLowerCase();
  return ACCEPTABLE_SERVER_STATUSES.has(status);
}

function findStatusEntry(entries, shopKey, shopName) {
  for (const row of entries) {
    const key = String(row.shopKey || row.key || '').trim();
    const name = String(row.shopName || row.liveRoomName || row.name || '').trim();
    if (key === shopKey) return row;
    if (name === shopName) return row;
    if (name && (name.includes(shopName) || shopName.includes(name))) return row;
  }
  return null;
}

function buildUploadPayload(collectedByKey) {
  const shops = {};
  for (const [shopKey, collected] of Object.entries(collectedByKey)) {
    const shopName = shopDisplayName(shopKey);
    shops[shopKey] = {
      shopName,
      liveRoomName: shopName,
      cookie: collected.cookie,
      userAgent: collected.userAgent || '',
      url: collected.lastSeenUrl || '',
    };
  }
  return {
    source: 'qianfan-robot',
    uploadedAt: new Date().toISOString(),
    shops,
  };
}

function parseUploadResponse(rawPayload, submittedKeys) {
  const data = unwrapApiData(rawPayload);
  const resultMap =
    (Array.isArray(data?.shops)
      ? Object.fromEntries(data.shops.filter((r) => r?.shopKey).map((r) => [r.shopKey, r]))
      : null) ||
    (data?.results && typeof data.results === 'object' ? data.results : null) ||
    (data?.shops && typeof data.shops === 'object' && !Array.isArray(data.shops) ? data.shops : null);

  const shops = [];
  let success = 0;
  let failed = 0;

  for (const shopKey of submittedKeys) {
    const entry = resultMap?.[shopKey];
    const explicitFail = entry?.success === false || entry?.ok === false;
    const explicitOk = entry?.success === true || entry?.ok === true;
    const ok = explicitOk || (!explicitFail && (data?.ok === true || data?.success === true || !resultMap));
    shops.push(
      buildShopResult(shopKey, {
        ok,
        cookiePreview: String(entry?.cookiePreview || '').trim(),
        message: ok
          ? String(entry?.message || data?.message || '提交成功')
          : String(entry?.error || entry?.message || data?.error || data?.message || '提交失败'),
      })
    );
    if (ok) success += 1;
    else failed += 1;
  }

  if (!resultMap && (data?.ok === true || data?.success === true)) {
    return {
      shops: submittedKeys.map((shopKey) => buildShopResult(shopKey, { ok: true, message: '提交成功' })),
      success: submittedKeys.length,
      failed: 0,
    };
  }

  return { shops, success, failed };
}

async function fetchShopCookieStatus(uploadCfg = getShopCookieUploadConfig()) {
  const url = `${uploadCfg.serverUrl}${uploadCfg.statusPath}`;
  const res = await fetchWithTimeout(
    url,
    { method: 'GET', headers: buildAuthHeadersGet(uploadCfg) },
    uploadCfg.timeoutMs
  );
  const raw = await res.json().catch(() => ({}));
  const data = unwrapApiData(raw);
  return { ok: res.ok, httpStatus: res.status, raw, data, entries: normalizeStatusEntries(raw) };
}

function applyStatusToShopResults(shopResults, statusPayload) {
  const entries = statusPayload.entries || [];
  const tokenRequired = statusPayload.raw?.tokenRequired ?? statusPayload.data?.tokenRequired;
  if (tokenRequired === false) {
    println('[Cookie上传] 服务器 tokenRequired=false，无需 Token');
  }

  for (const shop of shopResults) {
    const entry = findStatusEntry(entries, shop.shopKey, shop.shopName);
    if (!entry) continue;
    shop.serverStatus = String(entry.status || '').trim();
    shop.lastUploadAt = String(entry.lastUploadAt || entry.updatedAt || '').trim();
    const status = String(entry.status || '').toLowerCase();
    const label = formatServerStatusLabel(entry.status, entry.reason);

    if (status === 'invalid') {
      shop.ok = true;
      shop.message = `已上传，验证失败，请重新获取 Cookie（${entry.reason || 'invalid'}）`;
      println(`[Cookie上传] ${shop.shopName}：已上传但验证失败，请重新获取`);
    } else if (isServerReceived(entry)) {
      shop.ok = true;
      shop.message = `服务器已收到，状态：${label}`;
      shop.cookiePreview = shop.cookiePreview || String(entry.cookiePreview || '').trim();
      println(`[Cookie上传] 服务器已收到：${shop.shopName}，状态：${label}`);
    }
  }
  return shopResults;
}

async function verifyUploadStatus(uploadCfg, submittedKeys, shopResults) {
  const statusPayload = await fetchShopCookieStatus(uploadCfg);
  println(`[Cookie上传] GET ${uploadCfg.statusPath} -> ${statusPayload.httpStatus}`);
  if (!statusPayload.ok) {
    return {
      ok: false,
      error: statusPayload.raw?.message || statusPayload.data?.error || `状态检查 HTTP ${statusPayload.httpStatus}`,
      data: statusPayload.data,
    };
  }

  applyStatusToShopResults(shopResults, statusPayload);

  const verified = shopResults.filter((s) => submittedKeys.includes(s.shopKey) && s.ok);
  return {
    ok: verified.length > 0,
    verifiedCount: verified.length,
    total: submittedKeys.length,
    data: statusPayload.data,
    shops: shopResults,
  };
}

async function uploadShopCookiesBatch(collectedByKey, options = {}) {
  const uploadCfg = getShopCookieUploadConfig();
  if (!uploadCfg.enabled) {
    return { ok: false, reason: 'disabled', message: '四店 Cookie 上传未启用' };
  }

  const shopKeys = Object.keys(collectedByKey || {}).filter((k) => collectedByKey[k]?.cookie);
  if (!shopKeys.length) {
    return { ok: false, reason: 'empty', message: '没有可上传的 Cookie' };
  }

  const url = `${uploadCfg.serverUrl}${uploadCfg.uploadPath}`;
  const body = buildUploadPayload(collectedByKey);
  let res;
  let data = {};
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: buildAuthHeaders(uploadCfg),
        body: JSON.stringify(body),
      },
      uploadCfg.timeoutMs
    );
    data = await res.json().catch(() => ({}));
    const brief = JSON.stringify(unwrapApiData(data)).slice(0, 300);
    println(`[Cookie上传] POST ${uploadCfg.uploadPath} -> ${res.status} ${brief}`);
  } catch (err) {
    return {
      ok: false,
      reason: 'network_error',
      message: err.message || '网络请求失败',
      httpStatus: 0,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      reason: 'http_error',
      message: data.error || data.message || `HTTP ${res.status}`,
      httpStatus: res.status,
      data,
    };
  }

  const parsed = parseUploadResponse(data, shopKeys);
  let shopResults = parsed.shops;

  if (options.verifyStatus !== false) {
    try {
      const verify = await verifyUploadStatus(uploadCfg, shopKeys, shopResults);
      shopResults = verify.shops || shopResults;
    } catch (err) {
      println(`[Cookie上传] 状态确认失败：${err.message || err}`);
    }
  }

  const success = shopResults.filter((s) => s.ok).length;
  const failed = shopResults.length - success;
  const allOk = success === shopKeys.length;

  return {
    ok: allOk,
    reason: allOk ? 'ok' : success > 0 ? 'partial_failed' : 'failed',
    message: allOk
      ? `四店 Cookie 已全部提交（${success}/${shopKeys.length}）`
      : success > 0
        ? `部分店铺提交成功（${success}/${shopKeys.length}）`
        : `Cookie 提交失败（0/${shopKeys.length}）`,
    httpStatus: res.status,
    data,
    shops: shopResults,
    success,
    failed,
  };
}

function buildMissingShopResults(missingShopNames) {
  return missingShopNames.map((shopName) =>
    buildShopResult(SHOP_KEY_BY_NAME[shopName] || shopName, {
      shopName,
      ok: false,
      message: '未能从千帆读取 Cookie，请确认该店客服台已打开',
    })
  );
}

function summarizeUploadMessage(result) {
  if (result.skipped) return result.message || '已跳过';
  if (!result.shops?.length) return result.message || '上传失败';
  const okShops = result.shops.filter((s) => s.ok).map((s) => s.shopName);
  const failShops = result.shops.filter((s) => !s.ok).map((s) => `${s.shopName}（${s.message}）`);
  if (result.ok) return `Cookie 提交成功：${okShops.join('、')}`;
  if (okShops.length && failShops.length) {
    return `Cookie 部分成功：${okShops.join('、')}；失败：${failShops.join('、')}`;
  }
  return `Cookie 提交失败：${failShops.join('、') || result.message}`;
}

async function runShopCookieUploadAll(reason = 'manual', options = {}) {
  const uploadCfg = getShopCookieUploadConfig();
  if (!uploadCfg.enabled) {
    return {
      ok: false,
      skipped: true,
      message: '四店 Cookie 上传未启用',
      shops: [],
      success: 0,
      failed: CANONICAL_SHOPS.length,
      total: CANONICAL_SHOPS.length,
    };
  }

  logUploadConfig(uploadCfg);

  const { collectedByKey, missing, count } = await collectAllShopCookies({
    useDevToolsFallback: options.useDevToolsFallback !== false,
  });
  const missingResults = buildMissingShopResults(missing);

  if (!count) {
    return {
      ok: false,
      message: '暂未采集到任何店铺 Cookie，请确认千帆客服台已打开并登录',
      shops: missingResults,
      success: 0,
      failed: CANONICAL_SHOPS.length,
      total: CANONICAL_SHOPS.length,
      missing,
      reason,
    };
  }

  println(`[Cookie上传] 准备提交 ${count} 个店铺 Cookie`);

  let uploadResult;
  try {
    uploadResult = await uploadShopCookiesBatch(collectedByKey, { verifyStatus: options.verifyStatus });
  } catch (err) {
    uploadResult = {
      ok: false,
      message: err.message || String(err),
      shops: Object.keys(collectedByKey).map((shopKey) =>
        buildShopResult(shopKey, { ok: false, message: err.message || String(err) })
      ),
      success: 0,
      failed: Object.keys(collectedByKey).length,
    };
  }

  const merged = [...(uploadResult.shops || []), ...missingResults];
  const success = merged.filter((s) => s.ok).length;
  const failed = merged.length - success;
  const submittedOk = success >= count;
  const allFourOk = success === CANONICAL_SHOPS.length;

  println(`[Cookie上传] 完成：${success}/${CANONICAL_SHOPS.length}（已采集 ${count} 店）reason=${reason}`);

  return {
    ...uploadResult,
    ok: submittedOk,
    allFourOk,
    shops: merged,
    success,
    failed,
    total: CANONICAL_SHOPS.length,
    missing,
    reason,
    message: summarizeUploadMessage({ ok: submittedOk, shops: merged, message: uploadResult.message }),
  };
}

function triggerShopCookieUploadOnBuyerMessage() {
  const uploadCfg = getShopCookieUploadConfig();
  if (!uploadCfg.enabled) {
    return Promise.resolve({ ok: false, skipped: true, message: 'skipped' });
  }
  if (pendingBuyerUpload) return pendingBuyerUpload;

  pendingBuyerUpload = new Promise((resolve) => {
    setTimeout(() => {
      pendingBuyerUpload = null;
      void runShopCookieUploadAll('buyer_message', { verifyStatus: true })
        .then((result) => {
          if (result.ok) {
            println(`[Cookie上传] 买家消息触发完成 ${result.success}/${CANONICAL_SHOPS.length}`);
          } else if (!result.skipped) {
            println(`[Cookie上传] 买家消息触发失败：${result.message}`);
          }
          resolve(result);
        })
        .catch((err) => {
          resolve({ ok: false, message: err.message || String(err), shops: [], success: 0, failed: 4 });
        });
    }, BUYER_MESSAGE_DEBOUNCE_MS);
  });
  return pendingBuyerUpload;
}

module.exports = {
  CANONICAL_SHOPS,
  SHOP_KEY_BY_NAME,
  SHOP_NAME_BY_KEY,
  getShopCookieUploadConfig,
  collectAllShopCookies,
  uploadShopCookiesBatch,
  runShopCookieUploadAll,
  triggerShopCookieUploadOnBuyerMessage,
  summarizeUploadMessage,
  fetchShopCookieStatus,
  maskCookiePreview,
};
