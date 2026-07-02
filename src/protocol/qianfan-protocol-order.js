/**
 * 千帆纯协议 — 订单拉取 + 自动解密（eva/walle Cookie + AT token）
 */
const { findProtocolShopConfig, loadProtocolShopConfigs } = require('./qianfan-protocol-config');
const { buildSignedOrderFetchHeaders } = require('./qianfan-order-xhs-sign');

const EVA_ORIGIN = 'https://eva.xiaohongshu.com';
const WALLE_ORIGIN = 'https://walle.xiaohongshu.com';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return null;
  }
}

function extractAtToken(cookie) {
  const text = String(cookie || '');
  const patterns = [
    /access-token-walle\.xiaohongshu\.com=customer\.eva\.(AT-[A-Za-z0-9]+)/i,
    /walle-eva-auth=[^!]*!!(AT-[A-Za-z0-9]+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return '';
}

function latin1HeaderValue(value) {
  return String(value ?? '')
    .replace(/\u2026/g, '')
    .replace(/[^\x00-\xFF]/g, '')
    .trim();
}

function headersForFetch(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const val = latin1HeaderValue(v);
    if (val) out[String(k)] = val;
  }
  return out;
}

function parseSensitiveField(value) {
  const s = String(value || '');
  const idx = s.indexOf('@@');
  if (idx < 0) return { masked: s, sensitiveKey: '' };
  return { masked: s.slice(0, idx), sensitiveKey: s.slice(idx + 2).trim() };
}

function formatEpochSeconds(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function dateRangeToMs(beginDate, endDate) {
  const begin = String(beginDate || '').trim();
  const end = String(endDate || '').trim();
  if (!begin && !end) return {};
  const parseDayStart = (s) => {
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return NaN;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
  };
  const parseDayEnd = (s) => {
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return NaN;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime();
  };
  const out = {};
  if (begin) out.createTimeBegin = parseDayStart(begin);
  if (end) out.createTimeEnd = parseDayEnd(end);
  return out;
}

function sanitizeHeaderValue(value) {
  return latin1HeaderValue(value);
}

function pickTemplateHeaders(shopConfig, templateKey) {
  return shopConfig?.httpTemplates?.[templateKey]?.headers || {};
}

function buildSignedHeaders(shopConfig, templateKey, extra = {}) {
  const tpl = pickTemplateHeaders(shopConfig, templateKey);
  const at = extractAtToken(shopConfig.cookie) || sanitizeHeaderValue(tpl.Authorization || tpl.authorization);
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'User-Agent':
      latin1HeaderValue(shopConfig.userAgent) ||
      sanitizeHeaderValue(tpl['User-Agent']) ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) eva/1.2.6 Chrome/128.0.6613.186 Electron/32.2.8 Safari/537.36',
    Referer:
      latin1HeaderValue(shopConfig.referer) ||
      sanitizeHeaderValue(tpl.Referer) ||
      'https://walle.xiaohongshu.com/',
    'X-t': String(Date.now()),
    ...extra,
  };
  const xCommon = sanitizeHeaderValue(tpl['X-S-Common']);
  const xs = sanitizeHeaderValue(tpl['X-s']);
  if (xCommon) headers['X-S-Common'] = xCommon;
  if (xs) headers['X-s'] = xs;
  for (const k of ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']) {
    const v = sanitizeHeaderValue(tpl[k]);
    if (v) headers[k] = v;
  }
  if (at) headers.Authorization = at;
  delete headers.authorization;
  return headersForFetch(headers);
}

function buildEvaHeaders(shopConfig, templateKey = 'orderSearchList') {
  return buildSignedHeaders(shopConfig, templateKey, { 'x-subsystem': 'eva' });
}

function buildWalleHeaders(shopConfig, templateKey = 'sensitiveInfoMobile') {
  return buildSignedHeaders(shopConfig, templateKey, {
    Cookie: latin1HeaderValue(shopConfig.cookie),
  });
}

async function protocolFetch(url, { method = 'GET', headers = {}, timeoutMs = 45000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const safeHeaders = headersForFetch(headers);
  try {
    const res = await fetch(url, { method, headers: safeHeaders, signal: ctrl.signal });
    const text = await res.text();
    const json = parseJsonSafe(text);
    return {
      ok: res.ok,
      status: res.status,
      url,
      json,
      text,
      apiCode: json?.code,
      apiMsg: json?.msg || json?.message || '',
    };
  } finally {
    clearTimeout(timer);
  }
}

function resolveSellerId(shopConfig) {
  return (
    String(shopConfig.sellerId || '').trim() ||
    String(shopConfig.orderApiFlow?.sellerId || '').trim() ||
    ''
  );
}

async function fetchOrderSearchPage(shopConfig, options = {}) {
  const sellerId = resolveSellerId(shopConfig);
  if (!sellerId) {
    return { ok: false, error: `店铺 ${shopConfig.shopTitle} 缺少 sellerId` };
  }
  const page = Number(options.page) || 0;
  const limit = Number(options.limit) || 20;
  const params = new URLSearchParams();
  params.set('seller_id', sellerId);
  params.set('package_id', String(options.packageId || '').trim());
  params.set('page', String(page));
  params.set('limit', String(limit));
  if (options.createTimeBegin) params.set('create_time_begin', String(options.createTimeBegin));
  if (options.createTimeEnd) params.set('create_time_end', String(options.createTimeEnd));
  const url = `${EVA_ORIGIN}/api/edith/package/search-list?${params.toString()}`;
  const res = await protocolFetch(url, {
    headers: buildEvaHeaders(shopConfig, 'orderSearchList'),
  });
  if (!res.ok || !res.json || res.json.code !== 0) {
    return {
      ok: false,
      error: res.apiMsg || res.text?.slice(0, 200) || `HTTP ${res.status}`,
      status: res.status,
      url,
    };
  }
  const data = res.json.data || {};
  return {
    ok: true,
    url,
    total: Number(data.total) || 0,
    resultList: Array.isArray(data.result_list) ? data.result_list : [],
    page,
    limit,
  };
}

async function fetchAllOrderList(shopConfig, options = {}) {
  const limit = Number(options.limit) || 20;
  const maxPages = Number(options.maxPages) || 100;
  const all = [];
  let total = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const pageRes = await fetchOrderSearchPage(shopConfig, { ...options, page, limit });
    if (!pageRes.ok) return pageRes;
    total = pageRes.total;
    all.push(...pageRes.resultList);
    if (pageRes.resultList.length < limit) break;
    if (total > 0 && all.length >= total) break;
    if (options.pageDelayMs) await sleep(options.pageDelayMs);
  }
  return { ok: true, total, resultList: all };
}

async function fetchPackageDetail(shopConfig, packageId) {
  const pid = String(packageId || '').trim();
  if (!pid) return { ok: false, error: '缺少 packageId' };
  const url = `${EVA_ORIGIN}/api/edith/package/${encodeURIComponent(pid)}/detail`;
  const res = await protocolFetch(url, {
    headers: buildEvaHeaders(shopConfig, 'packageDetail'),
  });
  if (!res.ok || !res.json || (res.json.code !== 0 && !res.json.success)) {
    return {
      ok: false,
      error: res.apiMsg || res.text?.slice(0, 200) || `HTTP ${res.status}`,
      status: res.status,
    };
  }
  return { ok: true, data: res.json.data || {} };
}

async function fetchPackageDecrypt(shopConfig, packageId) {
  const pid = String(packageId || '').trim();
  if (!pid) return { ok: false, error: '缺少 packageId' };
  const url = `${EVA_ORIGIN}/api/edith/get/package/decrypt?packageId=${encodeURIComponent(pid)}`;
  try {
    const headers = buildSignedOrderFetchHeaders(shopConfig, url, {
      referer: 'https://walle.xiaohongshu.com/',
    });
    const res = await protocolFetch(url, { headers });
    if (res.ok && res.json && (res.json.code === 0 || res.json.success === true)) {
      return { ok: true, data: res.json.data || {}, via: 'xhs-sign' };
    }
    return { ok: false, error: res.apiMsg || res.text?.slice(0, 120) || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

async function fetchSensitiveInfo(shopConfig, sensitiveKey, kind = 'Mobile') {
  const key = String(sensitiveKey || '').trim();
  if (!key) return { ok: false, error: '缺少 sensitiveKey', plain: '' };
  const url = `${WALLE_ORIGIN}/api/edith/walle/get_sensitive_info?sensitiveKey=${encodeURIComponent(key)}`;
  const referer =
    kind === 'Name' && shopConfig.lastPackageId
      ? `https://walle.xiaohongshu.com/cstools/tools/packages/${shopConfig.lastPackageId}`
      : 'https://walle.xiaohongshu.com/cstools/tools/packages';
  try {
    const headers = buildSignedOrderFetchHeaders(shopConfig, url, { referer });
    const res = await protocolFetch(url, { headers });
    if (res.ok && res.json?.success === true) {
      return { ok: true, plain: String(res.json.data ?? '').trim(), via: 'xhs-sign' };
    }
    return {
      ok: false,
      error: res.apiMsg || res.text?.slice(0, 120) || `HTTP ${res.status}`,
      plain: '',
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err), plain: '' };
  }
}

function flattenSkuSnapshots(skuSnapshots) {
  const rows = Array.isArray(skuSnapshots) ? skuSnapshots : [];
  const names = [];
  const specs = [];
  const qtys = [];
  const prices = [];
  const statuses = [];
  const skuCodes = [];
  const categories = [];
  for (const sku of rows) {
    names.push(String(sku.item_name || sku.name || sku.title || '').trim());
    specs.push(String(sku.variant_name || sku.spec || sku.sku_name || '').trim());
    qtys.push(String(sku.quantity ?? ''));
    prices.push(String(sku.price ?? sku.deal_price ?? ''));
    statuses.push(String(sku.status_name || sku.after_sale_status || '').trim());
    skuCodes.push(String(sku.scsku_code || sku.sku_id || '').trim());
    const cats = Array.isArray(sku.categories) ? sku.categories.map((c) => c.name).filter(Boolean) : [];
    categories.push(cats.join('>'));
  }
  return {
    productNames: names.filter(Boolean).join(' | '),
    productSpecs: specs.filter(Boolean).join(' | '),
    quantities: qtys.filter(Boolean).join(' | '),
    productPrices: prices.filter(Boolean).join(' | '),
    afterSaleStatuses: statuses.filter(Boolean).join(' | '),
    skuCodes: skuCodes.filter(Boolean).join(' | '),
    categories: categories.filter(Boolean).join(' | '),
  };
}

function mergeOrderRow(shopConfig, listItem, detail = {}, decryptInfo = {}) {
  const phoneFromList = parseSensitiveField(listItem.phone);
  const addrFromList = parseSensitiveField(listItem.buyer_address);
  const phoneFromDetail = parseSensitiveField(detail.phone);
  const addrFromDetail = parseSensitiveField(detail.address);
  const nameFromDetail = parseSensitiveField(detail.user_name);
  const skuFlat = flattenSkuSnapshots(detail.sku_snapshots);

  const mobileKey =
    decryptInfo.mobileKey ||
    phoneFromDetail.sensitiveKey ||
    phoneFromList.sensitiveKey ||
    '';
  const addressKey =
    decryptInfo.addressKey ||
    addrFromDetail.sensitiveKey ||
    addrFromList.sensitiveKey ||
    '';
  const nameKey = decryptInfo.nameKey || nameFromDetail.sensitiveKey || '';

  return {
    shopTitle: shopConfig.shopTitle,
    orderId: String(listItem.order_id || detail.order_id || ''),
    packageId: String(listItem.package_id || detail.package_id || ''),
    status: String(listItem.csstatus || detail.status_name || detail.erp_status_str || detail.status || ''),
    buyerNick: String(listItem.buyer_user_name || detail.user_nick_name || ''),
    buyerUserId: String(listItem.buyer_user_id || detail.user_id || ''),
    recipientName: decryptInfo.namePlain || nameFromDetail.masked || '',
    phonePlain: decryptInfo.mobilePlain || '',
    phoneMasked: phoneFromList.masked || phoneFromDetail.masked || '',
    addressPlain: decryptInfo.addressPlain || '',
    addressMasked: addrFromList.masked || addrFromDetail.masked || '',
    shopName: String(listItem.shop_name || detail.seller_name || ''),
    sellerId: String(listItem.seller_id || detail.seller_id || resolveSellerId(shopConfig)),
    warehouse: String(listItem.whname || detail.whname || ''),
    expressNo: String(listItem.express_no || detail.express_number || detail.express_no || ''),
    expressCompany: String(detail.express_company || ''),
    createTime: String(listItem.create_time || formatEpochSeconds(detail.create_time)),
    finishTime: String(listItem.finish_time || formatEpochSeconds(detail.finish_time)),
    payTime: formatEpochSeconds(detail.pay_time),
    shipTime: String(detail.ship_time_format || ''),
    expectSendTime: String(detail.expect_send_time || ''),
    orderType: String(listItem.type || detail.package_type || ''),
    rawPrice: detail.raw_price ?? '',
    dealPrice: detail.deal_price ?? '',
    customerPayAmount: detail.customer_pay_amount ?? '',
    transPrice: detail.trans_price ?? '',
    payMethod: String(detail.pay_method || ''),
    payStatus: detail.pay_status ?? '',
    logisticsMode: String(detail.logistics_mode || ''),
    sendFrom: String(detail.send_from || ''),
    cancelApplied: detail.cancel_applied === true ? '是' : detail.cancel_applied === false ? '否' : '',
    packageStatus: detail.status ?? '',
    erpStatus: String(detail.erp_status_str || ''),
    canReadAddress: detail.canCurrentCsaReadAddr === true ? '是' : '',
    ...skuFlat,
    mobileSensitiveKey: mobileKey,
    addressSensitiveKey: addressKey,
    nameSensitiveKey: nameKey,
    decryptOk: decryptInfo.ok ? '是' : decryptInfo.skipped ? '跳过' : '否',
    decryptError: decryptInfo.error || '',
  };
}

async function autoDecryptOrder(shopConfig, listItem, detail = {}, options = {}) {
  const phoneFromList = parseSensitiveField(listItem.phone);
  const addrFromList = parseSensitiveField(listItem.buyer_address);
  const phoneFromDetail = parseSensitiveField(detail.phone || '');
  const addrFromDetail = parseSensitiveField(detail.address || '');
  const nameFromDetail = parseSensitiveField(detail.user_name || '');

  const mobileKey = phoneFromDetail.sensitiveKey || phoneFromList.sensitiveKey;
  const addressKey = addrFromDetail.sensitiveKey || addrFromList.sensitiveKey;
  const nameKey = nameFromDetail.sensitiveKey;

  const needsDecrypt = Boolean(mobileKey || addressKey || nameKey);
  if (!needsDecrypt) {
    return {
      ok: true,
      skipped: true,
      mobilePlain: String(listItem.phone || detail.phone || '').replace(/@@.*/, ''),
      addressPlain: String(listItem.buyer_address || detail.address || '').replace(/@@.*/, ''),
      namePlain: String(detail.user_name || '').replace(/@@.*/, ''),
      mobileKey: '',
      addressKey: '',
      nameKey: '',
    };
  }

  const packageId = String(listItem.package_id || detail.package_id || '').trim();
  const shopCtx = packageId ? { ...shopConfig, lastPackageId: packageId } : shopConfig;
  if (packageId && options.callDecrypt !== false) {
    await fetchPackageDecrypt(shopCtx, packageId);
    if (options.decryptDelayMs) await sleep(options.decryptDelayMs);
  }

  const out = {
    ok: true,
    mobileKey,
    addressKey,
    nameKey,
    mobilePlain: '',
    addressPlain: '',
    namePlain: '',
    error: '',
  };

  if (mobileKey) {
    const mobileRes = await fetchSensitiveInfo(shopCtx, mobileKey, 'Mobile');
    if (mobileRes.ok) out.mobilePlain = mobileRes.plain;
    else out.error = [out.error, mobileRes.error].filter(Boolean).join('; ');
    if (options.sensitiveDelayMs) await sleep(options.sensitiveDelayMs);
  }
  if (addressKey) {
    const addrRes = await fetchSensitiveInfo(shopCtx, addressKey, 'Address');
    if (addrRes.ok) out.addressPlain = addrRes.plain;
    else out.error = [out.error, addrRes.error].filter(Boolean).join('; ');
    if (options.sensitiveDelayMs) await sleep(options.sensitiveDelayMs);
  }
  if (nameKey) {
    const nameRes = await fetchSensitiveInfo(shopCtx, nameKey, 'Name');
    if (nameRes.ok) out.namePlain = nameRes.plain;
    else out.error = [out.error, nameRes.error].filter(Boolean).join('; ');
  }

  out.ok = Boolean(out.mobilePlain || out.addressPlain || out.namePlain || !needsDecrypt);
  return out;
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

function filterOrders(rows, filters = {}) {
  const status = String(filters.status || '').trim();
  const searchType = String(filters.searchType || 'all').trim();
  const searchText = String(filters.searchText || '').trim().toLowerCase();
  let out = rows;
  if (status && status !== 'all') {
    out = out.filter((r) => String(r.status || '') === status);
  }
  if (searchText) {
    out = out.filter((r) => {
      const pick = (field) => String(r[field] || '').toLowerCase();
      if (searchType === 'orderId') return pick('orderId').includes(searchText);
      if (searchType === 'packageId') return pick('packageId').includes(searchText);
      if (searchType === 'buyerNick') return pick('buyerNick').includes(searchText);
      if (searchType === 'phone') return pick('phonePlain').includes(searchText) || pick('phoneMasked').includes(searchText);
      if (searchType === 'expressNo') return pick('expressNo').includes(searchText);
      return (
        pick('orderId').includes(searchText) ||
        pick('packageId').includes(searchText) ||
        pick('buyerNick').includes(searchText) ||
        pick('phonePlain').includes(searchText) ||
        pick('expressNo').includes(searchText)
      );
    });
  }
  return out;
}

async function collectShopOrders(shopConfig, options = {}) {
  const started = Date.now();
  const range = dateRangeToMs(options.dateBegin, options.dateEnd);
  const listRes = await fetchAllOrderList(shopConfig, {
    ...range,
    limit: options.pageSize || 20,
    maxPages: options.maxPages || 100,
    pageDelayMs: options.pageDelayMs || 120,
  });
  if (!listRes.ok) {
    return { ok: false, shopTitle: shopConfig.shopTitle, error: listRes.error, rows: [], stats: {} };
  }

  let list = listRes.resultList;
  if (options.maxOrders > 0) list = list.slice(0, options.maxOrders);

  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 3, 8));
  const enriched = await mapPool(list, concurrency, async (item) => {
    const packageId = String(item.package_id || '').trim();
    let detail = {};
    if (packageId && options.fetchDetail !== false) {
      const detailRes = await fetchPackageDetail(shopConfig, packageId);
      if (detailRes.ok) detail = detailRes.data;
      if (options.detailDelayMs) await sleep(options.detailDelayMs);
    }
    let decryptInfo = { ok: true, skipped: true };
    if (options.autoDecrypt !== false) {
      decryptInfo = await autoDecryptOrder(shopConfig, item, detail, {
        decryptDelayMs: options.decryptDelayMs || 80,
        sensitiveDelayMs: options.sensitiveDelayMs || 80,
      });
    }
    return mergeOrderRow(shopConfig, item, detail, decryptInfo);
  });

  const filtered = filterOrders(enriched, options);
  const decryptOk = enriched.filter((r) => r.decryptOk === '是').length;
  return {
    ok: true,
    shopTitle: shopConfig.shopTitle,
    rows: filtered,
    stats: {
      listed: listRes.resultList.length,
      fetched: list.length,
      returned: filtered.length,
      decryptOk,
      elapsedMs: Date.now() - started,
      total: listRes.total,
    },
  };
}

async function collectOrdersQuery(options = {}) {
  const started = Date.now();
  const shopTitles = Array.isArray(options.shopTitles) ? options.shopTitles.filter(Boolean) : [];
  let shops = [];
  if (shopTitles.length) {
    shops = shopTitles.map((t) => findProtocolShopConfig(t, { allowIncomplete: true }));
  } else {
    shops = loadProtocolShopConfigs().shops;
  }

  shops = shops.filter((s) => s.enabled !== false && resolveSellerId(s));
  if (!shops.length) {
    return { ok: false, error: '没有可用的店铺配置（需 sellerId + cookie）', rows: [], stats: {} };
  }

  const allRows = [];
  const shopStats = [];
  for (const shop of shops) {
    const one = await collectShopOrders(shop, options);
    shopStats.push(one);
    if (one.ok) allRows.push(...one.rows);
  }

  const anyOk = shopStats.some((s) => s.ok);
  const firstErr = shopStats.find((s) => !s.ok)?.error || '';

  return {
    ok: anyOk,
    error: anyOk ? '' : firstErr || '所有店铺拉单失败',
    rows: allRows,
    stats: {
      shopCount: shops.length,
      totalRows: allRows.length,
      decryptOk: allRows.filter((r) => r.decryptOk === '是').length,
      elapsedMs: Date.now() - started,
      shops: shopStats.map((s) => ({
        shopTitle: s.shopTitle,
        ok: s.ok,
        error: s.error || '',
        ...(s.stats || {}),
      })),
    },
  };
}

const EXPORT_COLUMNS = [
  ['shopTitle', '配置店铺'],
  ['orderId', '订单号'],
  ['packageId', '包裹号'],
  ['status', '状态'],
  ['buyerNick', '用户名'],
  ['buyerUserId', '用户ID'],
  ['recipientName', '收件人'],
  ['phonePlain', '手机号'],
  ['addressPlain', '收货地址'],
  ['phoneMasked', '手机号(脱敏)'],
  ['addressMasked', '地址(脱敏)'],
  ['shopName', '商家名称'],
  ['sellerId', '商家ID'],
  ['warehouse', '发货仓'],
  ['expressNo', '运单号'],
  ['expressCompany', '快递公司'],
  ['createTime', '创建时间'],
  ['payTime', '支付时间'],
  ['shipTime', '发货时间'],
  ['expectSendTime', '预计发货'],
  ['finishTime', '完成时间'],
  ['rawPrice', '原价'],
  ['dealPrice', '成交价'],
  ['customerPayAmount', '实付金额'],
  ['transPrice', '运费'],
  ['payMethod', '支付方式'],
  ['payStatus', '支付状态'],
  ['orderType', '订单类型'],
  ['logisticsMode', '物流模式'],
  ['sendFrom', '发货地'],
  ['cancelApplied', '取消申请'],
  ['packageStatus', '包裹状态码'],
  ['erpStatus', 'ERP状态'],
  ['productNames', '商品名称'],
  ['productSpecs', '规格'],
  ['quantities', '数量'],
  ['productPrices', '单价'],
  ['categories', '类目'],
  ['skuCodes', 'SKU编码'],
  ['afterSaleStatuses', '售后状态'],
  ['canReadAddress', '可读地址'],
  ['decryptOk', '解密成功'],
  ['decryptError', '解密错误'],
];

function rowsToCsv(rows) {
  const header = EXPORT_COLUMNS.map(([, label]) => label);
  const keys = EXPORT_COLUMNS.map(([key]) => key);
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [header.map(esc).join(',')];
  for (const row of rows) {
    lines.push(keys.map((k) => esc(row[k])).join(','));
  }
  return `\uFEFF${lines.join('\n')}`;
}

module.exports = {
  collectOrdersQuery,
  collectShopOrders,
  fetchOrderSearchPage,
  fetchAllOrderList,
  fetchPackageDetail,
  fetchPackageDecrypt,
  fetchSensitiveInfo,
  mergeOrderRow,
  autoDecryptOrder,
  rowsToCsv,
  EXPORT_COLUMNS,
  dateRangeToMs,
  extractAtToken,
  resolveSellerId,
};
