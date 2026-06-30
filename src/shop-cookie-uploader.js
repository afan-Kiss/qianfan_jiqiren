/**
 * 四店 Cookie 批量上传到主播分析系统 /api/shop-cookies（Token 可选）
 */
const CDP = require('chrome-remote-interface');
const config = require('./wechat/wxbot-new-config');
const { fetchDevToolsJsonList, getPageTargets } = require('./devtools-list');
const { detectQianfanShopPages } = require('./page-finder');
const { registerQianfanWsBridge, findBridgeByShopTitle } = require('./qianfan-ws-bridge');
const { hashPrefix, hashCookie, detectShopFromQianfanContext } = require('./qianfan-cookie-collector');
const {
  collectFullCookiesFromBridge,
  logCookieCollectionDiagnostics,
  logCookieDiagnostics,
  cookieContainsA1,
  extractCookieKeys,
} = require('./qianfan-full-cookie-collect');
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

function normalizePageShopTitle(pageTitle) {
  return String(pageTitle || '')
    .trim()
    .replace(/-工作台\s*$/i, '')
    .replace(/工作台\s*$/i, '')
    .trim();
}

function matchPageToShop(pageTitle) {
  const title = normalizePageShopTitle(pageTitle);
  if (!title) return null;

  let best = null;
  let bestLen = 0;
  for (const row of CANONICAL_SHOPS) {
    for (const name of row.matchNames) {
      if (title !== name && !title.includes(name)) continue;
      if (name.length > bestLen) {
        best = row;
        bestLen = name.length;
      }
    }
  }
  if (best) return best;

  const lower = title.toLowerCase();
  if (lower.includes('xy') && (lower.includes('祥钰') || lower.includes('xiangyu'))) {
    return CANONICAL_SHOPS.find((s) => s.shopKey === 'xyxiangyu') || null;
  }
  return null;
}

function isXhsWorkbenchUrl(url) {
  const u = String(url || '').toLowerCase();
  return u.includes('xiaohongshu.com') || u.includes('xiaohongshu.net');
}

function findExactBridgeForShop(shopRow) {
  const { listRegisteredShops } = require('./qianfan-ws-bridge');
  const shopKey = shopRow.shopKey;
  for (const registered of listRegisteredShops()) {
    if (!registered || registered.startsWith('__')) continue;
    const bridge = findBridgeByShopTitle(registered);
    if (!bridge) continue;
    const pageTitle = String(bridge.pageInfo?.shopTitle || bridge.shopTitle || registered).trim();
    const matched = matchPageToShop(pageTitle);
    if (matched?.shopKey === shopKey) return bridge;
  }
  return null;
}

async function logCdpTargetInventory(missingRows = []) {
  const qd = config.qianfanDebug || {};
  const port = qd.devtoolsPort || 9322;
  const host = qd.devtoolsHost || '127.0.0.1';
  try {
    const list = await fetchDevToolsJsonList(port, host);
    const pages = getPageTargets(list);
    println(`[Cookie诊断] CDP 目标列表（共 ${pages.length} 个 page）`);
    for (const t of pages) {
      const matched = matchPageToShop(t.title || '');
      const selectedFor = matched ? matched.shopName : '';
      const xhs = isXhsWorkbenchUrl(t.url);
      println(
        `[Cookie诊断] target id=${t.id || '-'} type=${t.type || 'page'} title=${t.title || ''} url=${String(t.url || '').slice(0, 90)} xhs=${xhs} matchShop=${selectedFor || '-'}`
      );
    }
    if (missingRows.length) {
      println(`[Cookie诊断] 待采集店铺：${missingRows.map((r) => r.shopName).join('、')}`);
    }
  } catch (err) {
    println(`[Cookie诊断] 无法读取 CDP 目标列表：${err.message || err}`);
  }
}

async function collectShopCookieFromBridge(bridge, shopRow, pageMeta = {}) {
  const full = await collectFullCookiesFromBridge(bridge, { retryReload: true, logDiagnostics: false });
  if (!full?.cookie || full.cookie.length < 20) return null;

  const shopCtx = detectShopFromQianfanContext(bridge.pageInfo || pageMeta || {}, {
    shopTitle: shopRow.shopName,
    lastSeenUrl: full.pageUrl || bridge.pageInfo?.url,
  });

  const diagnostics = {
    ...(full.diagnostics || {}),
    shopName: shopRow.shopName,
    pageTitle: full.pageTitle || pageMeta.pageTitle || bridge.pageInfo?.pageTitle || '',
    url: full.pageUrl,
    targetId: full.targetId || pageMeta.targetId || '',
    browserContextId: full.browserContextId || '',
    payloadContainsA1: full.hasA1,
  };
  logCookieDiagnostics(shopRow.shopName, diagnostics);

  return {
    platform: 'qianfan',
    shopName: shopRow.shopName,
    shopId: shopCtx.shopId,
    accountName: shopCtx.accountName,
    cookie: full.cookie,
    cookieHash: full.cookieHash || hashCookie(full.cookie),
    hasA1: full.hasA1,
    cookieKeyCount: full.cookieKeyCount,
    cookieKeys: full.cookieKeys,
    source: 'qianfan-full-cdp',
    lastSeenUrl: full.pageUrl || shopCtx.lastSeenUrl,
    capturedAt: new Date().toISOString(),
    matchedBy: shopCtx.matchedBy,
    diagnostics,
    targetId: diagnostics.targetId,
    browserContextId: diagnostics.browserContextId,
    pageTitle: diagnostics.pageTitle,
  };
}

async function collectFromBridge(shopRow) {
  const bridge = findExactBridgeForShop(shopRow);
  if (!bridge) return null;
  return collectShopCookieFromBridge(bridge, shopRow);
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

  const candidatePages = (report.shops || []).filter((page) => {
    const matched = matchPageToShop(page.shopTitle || page.pageTitle || '');
    return matched && targets.has(matched.shopKey) && isXhsWorkbenchUrl(page.url);
  });

  for (const page of candidatePages) {
    const pageTitle = String(page.shopTitle || page.pageTitle || '').trim();
    const matched = matchPageToShop(pageTitle);
    if (!matched || !targets.has(matched.shopKey) || out.has(matched.shopKey)) continue;

    let client;
    try {
      client = await CDP({ target: page.webSocketDebuggerUrl });
      const bridge = await registerQianfanWsBridge(
        { ...page, targetId: page.id || page.targetId },
        client
      );
      const collected = await collectShopCookieFromBridge(bridge, matched, {
        pageTitle,
        targetId: page.id || '',
        url: page.url,
      });
      if (collected?.cookie) out.set(matched.shopKey, collected);
    } catch (err) {
      println(`[Cookie诊断] ${matched.shopName} CDP 采集失败：${err.message || err}`);
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
      continue;
    }
    missing.push(row);
  }

  if (missing.length && useDevToolsFallback) {
    await logCdpTargetInventory(missing);
    const cdpMap = await collectFromDevToolsForShops(missing);
    for (const row of [...missing]) {
      const collected = cdpMap.get(row.shopKey);
      if (!collected?.cookie) continue;
      collectedByKey[row.shopKey] = collected;
      const idx = missing.findIndex((m) => m.shopKey === row.shopKey);
      if (idx >= 0) missing.splice(idx, 1);
    }
  }

  const incomplete = [];
  for (const row of CANONICAL_SHOPS) {
    const collected = collectedByKey[row.shopKey];
    if (!collected) continue;
    if (!collected.hasA1 && !cookieContainsA1(collected.cookie)) {
      incomplete.push(row.shopName);
    }
  }

  return {
    collectedByKey,
    missing: missing.map((r) => r.shopName),
    incomplete,
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

function isValidCookieString(cookie) {
  if (typeof cookie !== 'string') return false;
  const trimmed = cookie.trim();
  if (!trimmed || trimmed.length < 20) return false;
  if (trimmed === '[object Object]') return false;
  return true;
}

function buildUploadPayload(collectedByKey) {
  const shops = {};
  for (const [shopKey, collected] of Object.entries(collectedByKey)) {
    const shopName = shopDisplayName(shopKey);
    const cookieStr = collected.cookie;
    const cookieType = typeof cookieStr;
    const payloadContainsA1 = cookieContainsA1(cookieStr);
    println(
      `[Cookie诊断] ${shopName} shop.cookie typeof=${cookieType} payload cookie containsA1=${payloadContainsA1} length=${cookieStr?.length || 0} keys=${(collected.cookieKeys || extractCookieKeys(cookieStr)).join(',')}`
    );
    if (!isValidCookieString(cookieStr)) {
      println(`[Cookie诊断] ${shopName} 跳过：cookie 不是有效字符串（typeof=${cookieType}）`);
      continue;
    }
    shops[shopKey] = {
      shopName,
      liveRoomName: shopName,
      cookie: cookieStr,
      userAgent: collected.userAgent || '',
      url: collected.lastSeenUrl || '',
      collectedAt: collected.capturedAt || new Date().toISOString(),
    };
  }
  return {
    source: 'qianfan-robot',
    uploadedAt: new Date().toISOString(),
    shops,
  };
}

function logServerUploadDiagnostics(data, shopKeys) {
  const resultMap =
    (Array.isArray(data?.shops)
      ? Object.fromEntries(data.shops.filter((r) => r?.shopKey).map((r) => [r.shopKey, r]))
      : null) ||
    (data?.shops && typeof data.shops === 'object' && !Array.isArray(data.shops) ? data.shops : null);
  if (!resultMap) return;
  for (const shopKey of shopKeys) {
    const entry = resultMap[shopKey];
    if (!entry) continue;
    const shopName = shopDisplayName(shopKey);
    println(
      `[Cookie诊断] ${shopName} 服务端 receivedContainsA1=${entry.receivedContainsA1} savedContainsA1=${entry.savedContainsA1} cookieFieldUsed=${entry.cookieFieldUsed || '-'} receivedLen=${entry.receivedCookieLength ?? '-'} status=${entry.status || entry.cookieStatus || '-'}`
    );
  }
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
    if (entry.canSyncOrders === false) {
      println(`[Cookie上传] ${shop.shopName}：canSyncOrders=false，原因：${entry.reason || '未知'}`);
    }
    const status = String(entry.status || '').toLowerCase();
    const label = formatServerStatusLabel(entry.status, entry.reason);

    if (status === 'invalid') {
      const reasonText = String(entry.reason || '');
      if (/缺少\s*a1/i.test(reasonText)) {
        shop.ok = false;
        shop.message = `服务器验证：Cookie 缺少 a1，请刷新该店商家后台后重新提交`;
        println(`[Cookie上传] ${shop.shopName}：服务器反馈缺少 a1，需重新采集完整 Cookie`);
      } else {
        shop.ok = true;
        shop.message = `已上传，验证失败，请重新获取 Cookie（${reasonText || 'invalid'}）`;
        println(`[Cookie上传] ${shop.shopName}：已上传但验证失败，请重新获取`);
      }
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
    const brief = JSON.stringify(unwrapApiData(data)).slice(0, 500);
    println(`[Cookie上传] POST ${uploadCfg.uploadPath} -> ${res.status} ${brief}`);
    logServerUploadDiagnostics(unwrapApiData(data), shopKeys);
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

function buildIncompleteShopResults(incompleteNames, collectedByKey) {
  return incompleteNames.map((shopName) => {
    const shopKey = SHOP_KEY_BY_NAME[shopName] || shopName;
    const collected = collectedByKey[shopKey];
    return buildShopResult(shopKey, {
      shopName,
      ok: false,
      length: collected?.cookie?.length || 0,
      message: '本地校验：Cookie 缺少 a1，未上传（请打开/刷新该店小红书商家后台后重试）',
    });
  });
}

function filterUploadableCookies(collectedByKey) {
  const uploadable = {};
  const skippedNoA1 = [];
  for (const [shopKey, collected] of Object.entries(collectedByKey || {})) {
    if (!isValidCookieString(collected.cookie)) {
      skippedNoA1.push(shopDisplayName(shopKey));
      println(`[Cookie上传] ${shopDisplayName(shopKey)}：cookie 无效（typeof=${typeof collected.cookie}），跳过上传`);
      continue;
    }
    const hasA1 = collected.hasA1 || cookieContainsA1(collected.cookie);
    if (hasA1) {
      uploadable[shopKey] = collected;
    } else {
      skippedNoA1.push(shopDisplayName(shopKey));
      println(`[Cookie上传] ${shopDisplayName(shopKey)}：缺少 a1，跳过上传`);
    }
  }
  return { uploadable, skippedNoA1 };
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

  const { collectedByKey, missing, incomplete, count } = await collectAllShopCookies({
    useDevToolsFallback: options.useDevToolsFallback !== false,
  });
  const missingResults = buildMissingShopResults(missing);
  const incompleteResults = buildIncompleteShopResults(incomplete || [], collectedByKey);
  const { uploadable, skippedNoA1 } = filterUploadableCookies(collectedByKey);

  if (!Object.keys(uploadable).length) {
    const allFailed = [...missingResults, ...incompleteResults];
    return {
      ok: false,
      message:
        count > 0
          ? `采集到 ${count} 店 Cookie，但均缺少 a1，未上传。请打开/刷新各店商家后台后重试`
          : '暂未采集到任何店铺 Cookie，请确认千帆客服台已打开并登录',
      shops: allFailed,
      success: 0,
      failed: CANONICAL_SHOPS.length,
      total: CANONICAL_SHOPS.length,
      missing,
      incomplete,
      skippedNoA1,
      reason,
    };
  }

  println(`[Cookie上传] 准备提交 ${Object.keys(uploadable).length} 个店铺 Cookie（含 a1）`);

  let uploadResult;
  try {
    uploadResult = await uploadShopCookiesBatch(uploadable, { verifyStatus: options.verifyStatus });
  } catch (err) {
    uploadResult = {
      ok: false,
      message: err.message || String(err),
      shops: Object.keys(uploadable).map((shopKey) =>
        buildShopResult(shopKey, { ok: false, message: err.message || String(err) })
      ),
      success: 0,
      failed: Object.keys(uploadable).length,
    };
  }

  const merged = [...(uploadResult.shops || []), ...incompleteResults, ...missingResults];
  const success = merged.filter((s) => s.ok).length;
  const failed = merged.length - success;
  const uploadedCount = Object.keys(uploadable).length;
  const submittedOk = success >= uploadedCount && uploadedCount > 0;
  const allFourOk = success === CANONICAL_SHOPS.length;

  println(`[Cookie上传] 完成：${success}/${CANONICAL_SHOPS.length}（已上传 ${uploadedCount} 店）reason=${reason}`);

  return {
    ...uploadResult,
    ok: submittedOk,
    allFourOk,
    shops: merged,
    success,
    failed,
    total: CANONICAL_SHOPS.length,
    missing,
    incomplete,
    skippedNoA1,
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
  cookieContainsA1,
  matchPageToShop,
};
