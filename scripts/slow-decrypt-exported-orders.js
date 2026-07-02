#!/usr/bin/env node
/** 慢速重解密（xhshow 动态签名 + 限速），输出 _最终.json + _最终.csv */const fs = require('fs');
const path = require('path');
const os = require('os');
const { findProtocolShopConfig } = require('../src/protocol/qianfan-protocol-config');
const { autoDecryptOrder, mergeOrderRow } = require('../src/protocol/qianfan-protocol-order');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const inPath =
    process.argv[2] ||
    path.join(os.homedir(), 'Desktop', '千帆订单_四店全量_20260301-20260702_1829条.json');
  const delayMs = Number(process.argv[3]) || 900;
  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const rows = data.rows || [];
  let phoneOk = 0;
  let addrOk = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.phonePlain) phoneOk += 1;
    if (row.addressPlain) addrOk += 1;
    if (row.phonePlain && row.addressPlain) continue;

    const shopTitle = row.shopTitle || '祥钰珠宝';
    let shop;
    try {
      shop = findProtocolShopConfig(shopTitle, { allowIncomplete: true });
    } catch {
      shop = findProtocolShopConfig('祥钰珠宝', { allowIncomplete: true });
    }
    const list = row.listApiRaw ? JSON.parse(row.listApiRaw) : {};
    const detail = row.detailApiRaw ? JSON.parse(row.detailApiRaw) : {};
    const info = await autoDecryptOrder(shop, list, detail, {
      decryptDelayMs: 250,
      sensitiveDelayMs: 350,
    });
    Object.assign(row, mergeOrderRow(shop, list, detail, info));

    const la = String(row.list_buyer_address || '');
    if (la && !la.includes('@@') && !row.addressPlain) row.addressPlain = la;

    if (row.phonePlain) phoneOk += 1;
    if (row.addressPlain) addrOk += 1;
    if ((i + 1) % 20 === 0) {
      console.log(`[slow-decrypt] ${i + 1}/${rows.length} phone=${phoneOk} addr=${addrOk}`);
    }
    await sleep(delayMs);
  }

  const base = inPath.replace(/\.json$/i, '');
  const outJson = `${base}_最终.json`;
  const outCsv = `${base}_最终.csv`;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  fs.writeFileSync(
    outJson,
    JSON.stringify({ ...data, rows, phonePlainCount: phoneOk, addressPlainCount: addrOk, finishedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
  fs.writeFileSync(outCsv, `\uFEFF${[cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')}`, 'utf8');
  console.log(`[slow-decrypt] 完成 phone=${phoneOk} addr=${addrOk} / ${rows.length}`);
  console.log(`[slow-decrypt] ${outCsv}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
