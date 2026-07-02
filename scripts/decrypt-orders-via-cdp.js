#!/usr/bin/env node
/** 启动 CDP → 通过页面 fetch 解密已导出订单（解决 X-S-Common 过期） */
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../src/wechat/wxbot-new-config');
const { ensureQianfanClientDebugReady } = require('../src/qianfan-client-launcher');
const { runQianfanShopAttachReport } = require('../src/qianfan-debug-launcher');
const { startQianfanMessageListener } = require('../src/qianfan-message-listener');
const { getAllQianfanBridges } = require('../src/qianfan-ws-bridge');
const { findProtocolShopConfig } = require('../src/protocol/qianfan-protocol-config');
const { autoDecryptOrder, mergeOrderRow } = require('../src/protocol/qianfan-protocol-order');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureCdpBridges() {
  const qianfanCfg = { ...config.qianfanDebug, root: config.root };
  await ensureQianfanClientDebugReady(qianfanCfg);
  const attach = await runQianfanShopAttachReport(qianfanCfg);
  if (!attach?.canStartListener) {
    throw new Error('千帆 DevTools 未就绪，请先打开客服工作台');
  }
  await startQianfanMessageListener({
    devtoolsPort: qianfanCfg.devtoolsPort,
    devtoolsHost: qianfanCfg.devtoolsHost,
    expectedShopCount: qianfanCfg.expectedShopCount,
    shopReport: attach.shopReport,
    pages: attach.shopReport?.shops,
    onBuyerMessage: () => {},
  });
  for (let i = 0; i < 20; i += 1) {
    const bridges = getAllQianfanBridges().filter((b) => b.cdpReady);
    if (bridges.length) {
      console.log('[cdp-decrypt] bridges:', bridges.map((b) => b.shopTitle).join('、'));
      return;
    }
    await sleep(1000);
  }
  throw new Error('CDP bridge 未就绪');
}

async function main() {
  const inPath =
    process.argv[2] ||
    path.join(os.homedir(), 'Desktop', '千帆订单_四店全量_20260301-20260702_1829条.json');
  const limit = Number(process.argv[3]) || 0;
  const delayMs = Number(process.argv[4]) || 800;

  await ensureCdpBridges();

  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const rows = data.rows || [];
  const end = limit > 0 ? Math.min(limit, rows.length) : rows.length;
  let phoneOk = rows.filter((r) => r.phonePlain).length;
  let addrOk = rows.filter((r) => r.addressPlain).length;

  for (let i = 0; i < end; i += 1) {
    const row = rows[i];
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
    const hadPhone = Boolean(row.phonePlain);
    const hadAddr = Boolean(row.addressPlain);

    const info = await autoDecryptOrder(shop, list, detail, {
      decryptDelayMs: 200,
      sensitiveDelayMs: 300,
    });
    Object.assign(row, mergeOrderRow(shop, list, detail, info));

    const la = String(row.list_buyer_address || '');
    if (la && !la.includes('@@') && !row.addressPlain) row.addressPlain = la;

    if (!hadPhone && row.phonePlain) phoneOk += 1;
    if (!hadAddr && row.addressPlain) addrOk += 1;

    if ((i + 1) % 10 === 0 || i === 0) {
      console.log(
        `[cdp-decrypt] ${i + 1}/${end} phone=${phoneOk} addr=${addrOk} lastPhone=${row.phonePlain || '(空)'}`
      );
    }
    await sleep(delayMs);
  }

  const base = inPath.replace(/\.json$/i, '');
  const outJson = `${base}_解密CDP.json`;
  const outCsv = `${base}_解密CDP.csv`;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  fs.writeFileSync(
    outJson,
    JSON.stringify(
      {
        ...data,
        rows,
        phonePlainCount: rows.filter((r) => r.phonePlain).length,
        addressPlainCount: rows.filter((r) => r.addressPlain).length,
        finishedAt: new Date().toISOString(),
        via: 'cdp',
      },
      null,
      2
    ),
    'utf8'
  );
  fs.writeFileSync(
    outCsv,
    `\uFEFF${[cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')}`,
    'utf8'
  );
  console.log(`[cdp-decrypt] 完成 phone=${rows.filter((r) => r.phonePlain).length} addr=${rows.filter((r) => r.addressPlain).length} / ${rows.length}`);
  console.log(`[cdp-decrypt] ${outCsv}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
