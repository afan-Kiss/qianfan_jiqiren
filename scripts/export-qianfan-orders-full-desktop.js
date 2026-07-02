#!/usr/bin/env node
/**
 * 全量导出千帆订单到桌面（四店 · 自动解密 · 含接口原始字段）
 * 用法: node scripts/export-qianfan-orders-full-desktop.js [--begin 2026-03-01] [--end 2026-07-02]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadProtocolShopConfigs } = require('../src/protocol/qianfan-protocol-config');
const {
  fetchAllOrderList,
  fetchPackageDetail,
  autoDecryptOrder,
  mergeOrderRow,
  resolveSellerId,
  dateRangeToMs,
} = require('../src/protocol/qianfan-protocol-order');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const out = {
    begin: '2026-03-01',
    end: new Date().toISOString().slice(0, 10),
    concurrency: 4,
    outDir: path.join(os.homedir(), 'Desktop'),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--begin') out.begin = String(argv[++i] || out.begin);
    else if (a === '--end') out.end = String(argv[++i] || out.end);
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]) || out.concurrency;
    else if (a === '--out-dir') out.outDir = String(argv[++i] || out.outDir);
  }
  return out;
}

function flattenValue(v) {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function buildFullRow(shopConfig, listItem, detail, decryptInfo) {
  const base = mergeOrderRow(shopConfig, listItem, detail, decryptInfo);
  const extra = {};
  for (const [k, v] of Object.entries(listItem || {})) {
    extra[`list_${k}`] = flattenValue(v);
  }
  for (const [k, v] of Object.entries(detail || {})) {
    extra[`detail_${k}`] = flattenValue(v);
  }
  return {
    ...extra,
    ...base,
    listApiRaw: JSON.stringify(listItem || {}),
    detailApiRaw: JSON.stringify(detail || {}),
  };
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const total = items.length;
  const runners = Array(Math.min(concurrency, items.length))
    .fill(0)
    .map(async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        results[i] = await worker(items[i], i);
        done += 1;
        if (done % 20 === 0 || done === total) {
          console.log(`[export] 进度 ${done}/${total}`);
        }
      }
    });
  await Promise.all(runners);
  return results;
}

async function exportShop(shopConfig, args) {
  const sellerId = resolveSellerId(shopConfig);
  if (!sellerId) {
    console.warn(`[export] 跳过 ${shopConfig.shopTitle}：无 sellerId`);
    return [];
  }
  console.log(`[export] ${shopConfig.shopTitle} 拉列表 sellerId=${sellerId} ${args.begin}~${args.end}`);
  const range = dateRangeToMs(args.begin, args.end);
  const listRes = await fetchAllOrderList(shopConfig, {
    ...range,
    limit: 20,
    maxPages: 500,
    pageDelayMs: 100,
  });
  if (!listRes.ok) {
    console.error(`[export] ${shopConfig.shopTitle} 列表失败: ${listRes.error}`);
    return [];
  }
  console.log(`[export] ${shopConfig.shopTitle} 共 ${listRes.resultList.length} 条（total=${listRes.total}）`);
  const rows = await mapPool(listRes.resultList, args.concurrency, async (item) => {
    const packageId = String(item.package_id || '').trim();
    let detail = {};
    if (packageId) {
      const detailRes = await fetchPackageDetail(shopConfig, packageId);
      if (detailRes.ok) detail = detailRes.data;
      await sleep(60);
    }
    const decryptInfo = await autoDecryptOrder(shopConfig, item, detail, {
      decryptDelayMs: 50,
      sensitiveDelayMs: 50,
    });
    return buildFullRow(shopConfig, item, detail, decryptInfo);
  });
  return rows;
}

function collectColumns(rows) {
  const preferred = [
    'shopTitle',
    'orderId',
    'packageId',
    'status',
    'buyerNick',
    'buyerUserId',
    'recipientName',
    'phonePlain',
    'addressPlain',
    'phoneMasked',
    'addressMasked',
    'shopName',
    'sellerId',
    'warehouse',
    'expressNo',
    'expressCompany',
    'createTime',
    'payTime',
    'shipTime',
    'expectSendTime',
    'finishTime',
    'productNames',
    'productSpecs',
    'quantities',
    'productPrices',
    'categories',
    'skuCodes',
    'afterSaleStatuses',
    'rawPrice',
    'dealPrice',
    'customerPayAmount',
    'transPrice',
    'payMethod',
    'payStatus',
    'orderType',
    'logisticsMode',
    'sendFrom',
    'cancelApplied',
    'packageStatus',
    'erpStatus',
    'canReadAddress',
    'decryptOk',
    'decryptError',
  ];
  const keys = new Set(preferred);
  for (const row of rows) {
    for (const k of Object.keys(row)) keys.add(k);
  }
  const rest = [...keys].filter((k) => !preferred.includes(k)).sort();
  return [...preferred.filter((k) => keys.has(k)), ...rest];
}

function rowsToCsv(rows, columns) {
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => esc(row[c])).join(','));
  }
  return `\uFEFF${lines.join('\n')}`;
}

const COLUMN_LABELS = {
  shopTitle: '配置店铺',
  orderId: '订单号',
  packageId: '包裹号',
  status: '状态',
  buyerNick: '买家昵称',
  buyerUserId: '用户ID',
  recipientName: '收件人',
  phonePlain: '手机号(明文)',
  addressPlain: '收货地址(明文)',
  phoneMasked: '手机号(脱敏)',
  addressMasked: '地址(脱敏)',
  shopName: '商家名称',
  productNames: '商品名称',
  productSpecs: '规格',
  quantities: '数量',
  listApiRaw: '列表接口原始JSON',
  detailApiRaw: '详情接口原始JSON',
};

function labelColumn(key) {
  if (COLUMN_LABELS[key]) return COLUMN_LABELS[key];
  if (key.startsWith('list_')) return `列表.${key.slice(5)}`;
  if (key.startsWith('detail_')) return `详情.${key.slice(7)}`;
  return key;
}

async function main() {
  const args = parseArgs(process.argv);
  const { shops } = loadProtocolShopConfigs();
  const enabled = shops.filter((s) => resolveSellerId(s));
  console.log(`[export] 店铺 ${enabled.map((s) => s.shopTitle).join('、')}`);
  console.log(`[export] 日期 ${args.begin} ~ ${args.end}`);
  console.log(`[export] 输出 ${args.outDir}`);

  const allRows = [];
  for (const shop of enabled) {
    const rows = await exportShop(shop, args);
    allRows.push(...rows);
  }

  if (!allRows.length) {
    console.error('[export] 未获取到任何订单，请检查 Cookie 是否过期');
    process.exit(1);
  }

  const columns = collectColumns(allRows);
  const headerLabels = columns.map(labelColumn);
  const stamp = `${args.begin.replace(/-/g, '')}-${args.end.replace(/-/g, '')}`;
  const baseName = `千帆订单_四店全量_${stamp}_${allRows.length}条`;

  const csvPath = path.join(args.outDir, `${baseName}.csv`);
  const jsonPath = path.join(args.outDir, `${baseName}.json`);

  const csvLines = [headerLabels.join(',')];
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  for (const row of allRows) {
    csvLines.push(columns.map((c) => esc(row[c])).join(','));
  }
  fs.writeFileSync(csvPath, `\uFEFF${csvLines.join('\n')}`, 'utf8');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        dateBegin: args.begin,
        dateEnd: args.end,
        shopCount: enabled.length,
        rowCount: allRows.length,
        decryptOk: allRows.filter((r) => r.decryptOk === '是').length,
        rows: allRows,
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(`[export] CSV → ${csvPath}`);
  console.log(`[export] JSON → ${jsonPath}`);
  console.log(
    `[export] 完成 ${allRows.length} 条，解密成功 ${allRows.filter((r) => r.decryptOk === '是').length} 条`
  );
}

main().catch((err) => {
  console.error('[export] 失败:', err.message || err);
  process.exit(1);
});
