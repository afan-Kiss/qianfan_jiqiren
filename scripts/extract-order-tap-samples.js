#!/usr/bin/env node
/**
 * 从协议抓包 JSONL 提取订单列表 / 买家手机号地址相关请求样本
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { resolveProjectRoot } = require('../src/shared/app-root');

const ORDER_URL_RE =
  /seller\/order|\/order\/|package\/|fulfillment|trade\/|receiver|address|phone|decrypt|cs\/tool|package\/list|order\/list|order\/detail|get\/package|package\/detail/i;
const SENSITIVE_BODY_RE =
  /receiverName|receiverPhone|receiverAddress|packageId|orderId|phoneNo|mobile|decrypt|收货|手机|地址|province|city|district|detailAddress/i;

function todayLogPath() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(resolveProjectRoot(), 'logs', 'debug', `qianfan-protocol-tap-${y}-${m}-${day}.jsonl`);
}

function pickArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function redactCookie(headers) {
  const h = { ...(headers || {}) };
  if (h.Cookie) h.Cookie = `[len=${String(h.Cookie).length}]`;
  if (h.cookie) h.cookie = `[len=${String(h.cookie).length}]`;
  if (h.Authorization && String(h.Authorization).length > 20) {
    h.Authorization = `${String(h.Authorization).slice(0, 12)}…`;
  }
  return h;
}

function pairKey(row) {
  return `${row.shopTitle || ''}|${row.requestId || ''}|${row.url || ''}`;
}

async function main() {
  const logPath = pickArg('--log', todayLogPath());
  const since = pickArg('--since', '2026-07-02T09:25:00');
  const outDir = path.join(resolveProjectRoot(), 'logs', 'debug', 'order-tap-samples');
  fs.mkdirSync(outDir, { recursive: true });

  if (!fs.existsSync(logPath)) {
    console.error('log not found:', logPath);
    process.exit(1);
  }

  const urlCounts = new Map();
  const byReq = new Map();
  const rows = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(logPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const t = String(o.time || '');
    if (since && t < since) continue;
    const url = String(o.url || '');
    if (!url) continue;
    if (o.kind !== 'http_request' && o.kind !== 'http_response') continue;

    urlCounts.set(url, (urlCounts.get(url) || 0) + 1);

    const body = String(o.body || o.responseBody || '');
    const interesting = ORDER_URL_RE.test(url) || SENSITIVE_BODY_RE.test(body);
    if (!interesting) continue;

    const entry = {
      time: t,
      kind: o.kind,
      shopTitle: o.shopTitle,
      phase: o.phase,
      pageUrl: o.pageUrl,
      requestId: o.requestId,
      method: o.method,
      url,
      status: o.status,
      headers: redactCookie(o.headers),
      cookieKeysPreview: o.cookieKeysPreview,
      body: o.body || undefined,
      responseBody: o.responseBody || undefined,
    };

    rows.push(entry);
    const key = pairKey(o);
    if (!byReq.has(key)) byReq.set(key, {});
    const slot = byReq.get(key);
    if (o.kind === 'http_request') slot.request = entry;
    else slot.response = entry;
  }

  const pairs = [...byReq.values()].filter((p) => p.request || p.response);
  const paired = pairs
    .filter((p) => {
      const url = String(p.request?.url || p.response?.url || '');
      const body = String(p.request?.body || '') + String(p.response?.responseBody || '');
      return ORDER_URL_RE.test(url) || SENSITIVE_BODY_RE.test(body);
    })
    .map((p) => ({
      shopTitle: p.request?.shopTitle || p.response?.shopTitle,
      requestId: p.request?.requestId || p.response?.requestId,
      method: p.request?.method || p.response?.method,
      url: p.request?.url || p.response?.url,
      status: p.response?.status,
      time: p.request?.time || p.response?.time,
      request: p.request,
      response: p.response,
    }));

  const topUrls = [...urlCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);

  const stamp = Date.now();
  const summaryPath = path.join(outDir, `order-tap-summary-${stamp}.json`);
  const pairsPath = path.join(outDir, `order-tap-pairs-${stamp}.json`);
  const rowsPath = path.join(outDir, `order-tap-rows-${stamp}.jsonl`);

  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        extractedAt: new Date().toISOString(),
        logPath,
        since,
        totalInterestingRows: rows.length,
        pairedCount: paired.length,
        topUrls,
        pairedUrls: [...new Set(paired.map((p) => p.url))],
      },
      null,
      2
    )
  );
  fs.writeFileSync(pairsPath, JSON.stringify({ pairs: paired }, null, 2));
  fs.writeFileSync(rowsPath, rows.map((r) => JSON.stringify(r)).join('\n'));

  console.log('[order-tap] summary →', summaryPath);
  console.log('[order-tap] pairs →', pairsPath);
  console.log('[order-tap] rows →', rowsPath);
  console.log('[order-tap] paired', paired.length, 'interesting rows', rows.length);
  console.log('[order-tap] unique urls:', [...new Set(paired.map((p) => p.url))].join('\n  '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
