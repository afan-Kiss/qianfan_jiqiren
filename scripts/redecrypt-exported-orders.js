#!/usr/bin/env node
/** 对已导出 JSON 重新解密手机/地址/姓名并写回桌面 CSV+JSON */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { findProtocolShopConfig } = require('../src/protocol/qianfan-protocol-config');
const { autoDecryptOrder, mergeOrderRow } = require('../src/protocol/qianfan-protocol-order');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs() {
  const inPath =
    process.argv[2] ||
    path.join(os.homedir(), 'Desktop', '千帆订单_四店全量_20260301-20260702_1829条.json');
  return { inPath };
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const runners = Array(Math.min(concurrency, items.length))
    .fill(0)
    .map(async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        results[i] = await worker(items[i], i);
        done += 1;
        if (done % 50 === 0 || done === items.length) console.log(`[redecrypt] ${done}/${items.length}`);
      }
    });
  await Promise.all(runners);
  return results;
}

function collectColumns(rows) {
  const keys = new Set();
  for (const row of rows) for (const k of Object.keys(row)) keys.add(k);
  return [...keys];
}

async function main() {
  const { inPath } = parseArgs();
  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const rows = data.rows || [];
  console.log(`[redecrypt] 输入 ${rows.length} 条`);

  const updated = await mapPool(rows, 5, async (row) => {
    const shopTitle = row.shopTitle || row.shopName || '祥钰珠宝';
    let shop;
    try {
      shop = findProtocolShopConfig(shopTitle, { allowIncomplete: true });
    } catch {
      shop = findProtocolShopConfig('祥钰珠宝', { allowIncomplete: true });
    }
    const listItem = row.listApiRaw ? JSON.parse(row.listApiRaw) : {};
    const detail = row.detailApiRaw ? JSON.parse(row.detailApiRaw) : {};
    const decryptInfo = await autoDecryptOrder(shop, listItem, detail, {
      decryptDelayMs: 40,
      sensitiveDelayMs: 40,
    });
    const merged = mergeOrderRow(shop, listItem, detail, decryptInfo);
    return { ...row, ...merged };
  });

  const okPhone = updated.filter((r) => r.phonePlain).length;
  const okAddr = updated.filter((r) => r.addressPlain).length;
  const dir = path.dirname(inPath);
  const base = path.basename(inPath, '.json');
  const outJson = path.join(dir, `${base}_解密.csv`.replace('.csv', '.json'));
  const outCsv = path.join(dir, `${base}_解密.csv`);

  const columns = collectColumns(updated);
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const csvLines = [columns.join(',')];
  for (const row of updated) csvLines.push(columns.map((c) => esc(row[c])).join(','));
  fs.writeFileSync(outCsv, `\uFEFF${csvLines.join('\n')}`, 'utf8');
  fs.writeFileSync(
    outJson,
    JSON.stringify({ ...data, rows: updated, decryptOkPhone: okPhone, decryptOkAddress: okAddr, redecryptedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
  console.log(`[redecrypt] 手机号明文 ${okPhone} 地址明文 ${okAddr}`);
  console.log(`[redecrypt] CSV → ${outCsv}`);
  console.log(`[redecrypt] JSON → ${outJson}`);
}

main().catch((e) => {
  console.error('[redecrypt] 失败:', e.message || e);
  process.exit(1);
});
