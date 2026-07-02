#!/usr/bin/env node
/**
 * 从协议抓包提取千帆订单 API 样本（列表 / 详情 / 解密 / 敏感信息）并写入 data + local 配置
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
  localConfigPath,
  readJsonFile,
} = require('../src/protocol/qianfan-protocol-config');
const { saveLocalProtocolConfig } = require('../src/protocol/qianfan-live-context-extractor');
const { resolveProjectRoot } = require('../src/shared/app-root');

/** tap 抓包 shopTitle → seller_id（勿与别店混用） */
const SELLER_BY_SHOP = {
  祥钰珠宝: '691c5763084ee90015198056',
  和田雅玉: '6a195ac98228a600152aa204',
  'XY祥钰珠宝': '6a018fa530c9cf001512022a',
  拾玉居和田玉: '6a1a80892300910015e858f8',
};

const SELLER_SHOP_HINTS = { ...SELLER_BY_SHOP };

const API_PICKERS = [
  {
    key: 'orderSearchList',
    match: (url) => /\/api\/edith\/package\/search-list/i.test(url),
    prefer: (url) => !/create_time_/.test(url),
  },
  {
    key: 'packageDetail',
    match: (url) => /\/api\/edith\/package\/P\d+\/detail$/i.test(url),
  },
  {
    key: 'packageDecrypt',
    match: (url) => /\/api\/edith\/get\/package\/decrypt/i.test(url),
  },
  {
    key: 'sensitiveInfoMobile',
    match: (url) => /get_sensitive_info/i.test(url) && /sensitiveKey=MOBILE/i.test(url),
  },
  {
    key: 'sensitiveInfoAddress',
    match: (url) => /get_sensitive_info/i.test(url) && /sensitiveKey=ADDRESS/i.test(url),
  },
  {
    key: 'sensitiveInfoName',
    match: (url) => /get_sensitive_info/i.test(url) && /sensitiveKey=NAME/i.test(url),
  },
];

function parseArgs(argv) {
  const out = { help: false, since: '2026-07-02T09:25:00', merge: true };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--since') out.since = String(argv[++i] || out.since);
    else if (a === '--log') out.logPath = String(argv[++i] || '').trim();
    else if (a === '--no-merge') out.merge = false;
  }
  return out;
}

function todayLogPath() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(resolveProjectRoot(), 'logs', 'debug', `qianfan-protocol-tap-${y}-${m}-${day}.jsonl`);
}

function redactHeaders(headers) {
  const h = { ...(headers || {}) };
  for (const k of Object.keys(h)) {
    const lk = k.toLowerCase();
    if (lk === 'cookie' && h[k]) h[k] = `[len=${String(h[k]).length}]`;
    if (lk === 'authorization' && h[k]) h[k] = `${String(h[k]).slice(0, 16)}…`;
    if (lk === 'x-s-common' && h[k]) h[k] = `${String(h[k]).slice(0, 24)}…`;
    if (lk === 'x-s' && h[k]) h[k] = `${String(h[k]).slice(0, 16)}…`;
  }
  return h;
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return null;
  }
}

function extractSellerId(url) {
  const m = String(url || '').match(/seller_id=([a-f0-9]+)/i);
  return m ? m[1] : '';
}

function extractPackageId(url) {
  const m = String(url || '').match(/package\/(P\d+)\/detail/i);
  if (m) return m[1];
  const m2 = String(url || '').match(/packageId=(P\d+)/i);
  if (m2) return m2[1];
  const m3 = String(url || '').match(/package_id=(P\d+)/i);
  return m3 ? m3[1] : '';
}

function parseSensitiveKeyFromMasked(value) {
  const s = String(value || '');
  const idx = s.indexOf('@@');
  if (idx < 0) return '';
  return s.slice(idx + 2).trim();
}

function buildHttpTemplate(key, sample) {
  const url = String(sample.url || '');
  const method = String(sample.method || 'GET').toUpperCase();
  const headers = redactHeaders(sample.headers);
  delete headers.Authorization;
  delete headers.authorization;
  delete headers.Cookie;
  delete headers.cookie;
  if (key === 'orderSearchList') {
    const sellerId = extractSellerId(url) || '{sellerId}';
    return {
      url: `https://eva.xiaohongshu.com/api/edith/package/search-list?seller_id=${sellerId}&package_id=&page={page}&limit={limit}`,
      method: 'GET',
      headers,
      queryParams: {
        seller_id: sellerId,
        package_id: '',
        page: 0,
        limit: 20,
        create_time_begin: '{createTimeBegin}',
        create_time_end: '{createTimeEnd}',
      },
      host: 'eva.xiaohongshu.com',
      subsystem: 'eva',
    };
  }
  if (key === 'packageDetail') {
    return {
      url: 'https://eva.xiaohongshu.com/api/edith/package/{packageId}/detail',
      method: 'GET',
      headers,
      host: 'eva.xiaohongshu.com',
      subsystem: 'eva',
    };
  }
  if (key === 'packageDecrypt') {
    return {
      url: 'https://eva.xiaohongshu.com/api/edith/get/package/decrypt?packageId={packageId}',
      method: 'GET',
      headers,
      host: 'eva.xiaohongshu.com',
      subsystem: 'eva',
    };
  }
  if (key.startsWith('sensitiveInfo')) {
    return {
      url: 'https://walle.xiaohongshu.com/api/edith/walle/get_sensitive_info?sensitiveKey={sensitiveKey}',
      method: 'GET',
      headers,
      host: 'walle.xiaohongshu.com',
      subsystem: 'walle',
    };
  }
  return { url, method, headers };
}

function pickSampleRow(samples, picker) {
  const rows = samples.filter((s) => picker.match(s.url));
  if (!rows.length) return null;
  if (picker.prefer) {
    const preferred = rows.find((s) => picker.prefer(s.url));
    if (preferred) return preferred;
  }
  return rows[rows.length - 1];
}

async function readTapPairs(logPath, since) {
  const byReq = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(logPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (String(row.time || '') < since) continue;
    if (row.kind !== 'http_request' && row.kind !== 'http_response') continue;
    const url = String(row.url || '');
    if (!url) continue;
    const key = `${row.requestId || ''}|${url}`;
    if (!byReq.has(key)) byReq.set(key, {});
    const slot = byReq.get(key);
    if (row.kind === 'http_request') {
      slot.request = row;
    } else {
      slot.response = row;
    }
  }
  return [...byReq.values()]
    .filter((p) => p.request && p.response)
    .map((p) => ({
      time: p.request.time,
      shopTitle: p.request.shopTitle || p.response.shopTitle,
      requestId: p.request.requestId,
      method: p.request.method,
      url: p.request.url,
      headers: p.request.headers,
      body: p.request.body,
      status: p.response.status,
      responseBody: p.response.responseBody,
      responseJson: parseJsonSafe(p.response.responseBody),
    }));
}

function buildFlowExample(samples) {
  const list = pickSampleRow(samples, API_PICKERS[0]);
  if (!list?.responseJson?.data?.result_list?.length) return null;
  const first = list.responseJson.data.result_list[0];
  const packageId = first.package_id || extractPackageId(list.url);
  const detail = samples.find(
    (s) => s.url.includes(`/package/${packageId}/detail`) && s.responseJson
  );
  const decrypt = samples.find(
    (s) => s.url.includes('/get/package/decrypt') && s.url.includes(packageId)
  );
  const mobileKey = parseSensitiveKeyFromMasked(first.phone || detail?.responseJson?.data?.phone);
  const addressKey = parseSensitiveKeyFromMasked(
    first.buyer_address || detail?.responseJson?.data?.address
  );
  const nameKey = parseSensitiveKeyFromMasked(detail?.responseJson?.data?.user_name || '');
  const mobile = mobileKey
    ? samples.find((s) => s.url.includes(encodeURIComponent(mobileKey)) || s.url.includes(mobileKey))
    : null;
  const address = addressKey
    ? samples.find((s) => s.url.includes('ADDRESS') && (s.url.includes(encodeURIComponent(addressKey.split('.')[1] || '')) || s.url.includes('ADDRESS.')))
    : null;
  const name = nameKey
    ? samples.find((s) => /sensitiveKey=NAME/i.test(s.url))
    : null;

  return {
    packageId,
    orderId: first.order_id || detail?.responseJson?.data?.order_id || '',
    buyerUserId: first.buyer_user_id || detail?.responseJson?.data?.user_id || '',
    buyerNick: first.buyer_user_name || detail?.responseJson?.data?.user_nick_name || '',
    sellerId: first.seller_id || extractSellerId(list.url) || detail?.responseJson?.data?.seller_id || '',
    shopName: first.shop_name || detail?.responseJson?.data?.seller_name || '',
    sensitiveKeys: {
      mobile: mobileKey,
      address: addressKey,
      name: nameKey,
    },
    steps: {
      orderSearchList: list,
      packageDetail: detail || null,
      packageDecrypt: decrypt || null,
      sensitiveInfoMobile: mobile || null,
      sensitiveInfoAddress: address || null,
      sensitiveInfoName: name || null,
    },
  };
}

function mergeIntoLocalConfig(captured) {
  const shops = readJsonFile(localConfigPath());
  let changed = 0;
  for (const shop of shops) {
    const sellerId = SELLER_BY_SHOP[shop.shopTitle] || '';
    const flow =
      (sellerId && captured.flowsBySellerId[sellerId]) ||
      captured.flowsByShopName[shop.shopTitle] ||
      captured.defaultFlow;
    if (!flow) continue;

    shop.httpTemplates = shop.httpTemplates || {};
    shop.orderApiSamples = shop.orderApiSamples || {};
    shop.sellerId = sellerId || shop.sellerId || flow.sellerId || '';

    for (const picker of API_PICKERS) {
      const step = flow.steps?.[picker.key] || captured.apiSamples[picker.key];
      if (!step) continue;
      shop.httpTemplates[picker.key] = buildHttpTemplate(picker.key, step);
      shop.orderApiSamples[picker.key] = {
        capturedAt: captured.capturedAt,
        url: step.url,
        method: step.method,
        status: step.status,
        requestHeaders: redactHeaders(step.headers),
        responseBody: step.responseBody,
      };
    }

    shop.orderApiFlow = {
      packageId: flow.packageId,
      orderId: flow.orderId,
      buyerUserId: flow.buyerUserId,
      buyerNick: flow.buyerNick,
      sellerId: flow.sellerId,
      sensitiveKeys: flow.sensitiveKeys,
      notes:
        '列表/详情返回 phone、address、user_name 为脱敏+@@SENSITIVE_KEY；先 decrypt 再 get_sensitive_info 取明文',
    };
    changed += 1;
  }
  if (changed > 0) saveLocalProtocolConfig(shops);
  return changed;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      '用法: node scripts/save-order-api-captured-from-tap.js [--since ISO] [--log path] [--no-merge]'
    );
    process.exit(0);
  }

  const logPath = args.logPath || todayLogPath();
  if (!fs.existsSync(logPath)) {
    console.error('[order-api] 未找到抓包日志:', logPath);
    process.exit(1);
  }

  const samples = await readTapPairs(logPath, args.since);
  const apiSamples = {};
  for (const picker of API_PICKERS) {
    const row = pickSampleRow(samples, picker);
    if (row) apiSamples[picker.key] = row;
  }

  const flowsBySellerId = {};
  const flowsByShopName = {};
  for (const sellerId of Object.keys(SELLER_SHOP_HINTS)) {
    const shopHint = SELLER_SHOP_HINTS[sellerId];
    const subset = samples.filter(
      (s) =>
        s.url.includes(sellerId) ||
        String(s.shopTitle || '').trim() === shopHint
    );
    const flow = buildFlowExample(subset.length ? subset : samples);
    if (!flow) continue;
    flowsBySellerId[sellerId] = flow;
    flowsByShopName[SELLER_SHOP_HINTS[sellerId]] = flow;
  }
  const defaultFlow = buildFlowExample(samples);

  const captured = {
    capturedAt: new Date().toISOString(),
    sourceLog: logPath,
    since: args.since,
    apiSummary: {
      orderSearchList: 'GET eva.xiaohongshu.com/api/edith/package/search-list — 订单列表（脱敏手机/地址含 sensitiveKey）',
      packageDetail: 'GET eva.xiaohongshu.com/api/edith/package/{packageId}/detail — 订单详情',
      packageDecrypt: 'GET eva.xiaohongshu.com/api/edith/get/package/decrypt?packageId= — 查看敏感信息前授权',
      sensitiveInfoMobile: 'GET walle.../get_sensitive_info?sensitiveKey=MOBILE.* — 明文手机号',
      sensitiveInfoAddress: 'GET walle.../get_sensitive_info?sensitiveKey=ADDRESS.* — 明文地址',
      sensitiveInfoName: 'GET walle.../get_sensitive_info?sensitiveKey=NAME.* — 明文收件人',
    },
    apiSamples,
    defaultFlow,
    flowsBySellerId,
    flowsByShopName,
    httpTemplates: Object.fromEntries(
      API_PICKERS.map((p) => [p.key, apiSamples[p.key] ? buildHttpTemplate(p.key, apiSamples[p.key]) : null]).filter(
        ([, v]) => v
      )
    ),
  };

  const dataDir = path.join(resolveProjectRoot(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const outPath = path.join(dataDir, 'qianfan-order-api-captured.json');
  fs.writeFileSync(outPath, `${JSON.stringify(captured, null, 2)}\n`, 'utf8');
  console.log('[order-api] 已保存 →', outPath);
  console.log(
    '[order-api] 样本:',
    Object.keys(apiSamples).join(', ') || '(none)',
    'flows:',
    Object.keys(flowsBySellerId).length
  );

  if (args.merge) {
    const n = mergeIntoLocalConfig(captured);
    console.log(`[order-api] 已合并到 config/qianfan-protocol-shops.local.json（${n} 店）`);
  }
}

main().catch((err) => {
  console.error('[order-api] 失败:', err.message || err);
  process.exit(1);
});
