#!/usr/bin/env node
/**
 * 采集当前已登录各店的 Cookie（walle CDP jar + 可选 ark 换票）
 * 输出: tmp/shop-cookies/<店铺名>.walle.txt / .ark.txt + summary.json
 */
const fs = require('fs');
const path = require('path');
const config = require('../src/wechat/wxbot-new-config');
const CDP = require('chrome-remote-interface');
const { fetchDevToolsJsonList, getPageTargets } = require('../src/devtools-list');
const { detectQianfanShopPages } = require('../src/page-finder');
const {
  collectFullCookiesFromBridge,
  mergeCdpCookieEntries,
  cookieContainsArkToken,
  cookieContainsWalleToken,
  cookieContainsA1,
  extractCookieKeys,
} = require('../src/qianfan-full-cookie-collect');
const { registerQianfanWsBridge } = require('../src/qianfan-ws-bridge');
const { summarizeCookie } = require('../src/protocol/qianfan-protocol-config');
const { loadLiveSnapshot } = require('../src/protocol/qianfan-live-context-extractor');

const OUT_DIR = path.join('tmp', 'shop-cookies');
const WITH_ARK = process.argv.includes('--with-ark');

function safeFileName(name) {
  return String(name || 'shop').replace(/[\\/:*?"<>|]/g, '_').trim();
}

async function readJar(client) {
  await client.Network.enable();
  const all = await client.Network.getAllCookies();
  return mergeCdpCookieEntries(all?.cookies || []).cookie || '';
}

async function collectWalleFromCdp(shop) {
  let client;
  try {
    client = await CDP({ target: shop.webSocketDebuggerUrl });
    const bridge = await registerQianfanWsBridge(shop, client);
    const collected = await collectFullCookiesFromBridge(bridge, {
      readOnly: true,
      requireRecentNetworkHeader: false,
      networkHeaderWaitMs: 1500,
      includeJarFallback: true,
      logDiagnostics: false,
    });
    const jar = await readJar(client);
    const cookie = [collected?.cookie || '', jar].filter(Boolean).join('; ');
    const merged = cookie.split('; ').reduce((acc, part) => {
      const eq = part.indexOf('=');
      if (eq <= 0) return acc;
      acc.set(part.slice(0, eq).trim(), part.slice(eq + 1));
      return acc;
    }, new Map());
    const mergedCookie = [...merged.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    return mergedCookie;
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

async function collectViaLiveApi(shopTitle) {
  try {
    const loaded = await loadLiveSnapshot(shopTitle, { refresh: true });
    return String(loaded?.snapshot?.cookieSources?.mergedNetworkHeaderCookie || '').trim();
  } catch {
    return '';
  }
}

async function main() {
  const port = config.qianfanDebug?.devtoolsPort || 9322;
  const host = config.qianfanDebug?.devtoolsHost || '127.0.0.1';
  const list = await fetchDevToolsJsonList(port, host);
  const report = detectQianfanShopPages(getPageTargets(list), { expectedShopCount: 4 });
  const shops = report.shops;

  if (!shops.length) {
    console.error('[dump-cookies] 未找到已登录店铺，请确认千帆客服台已打开');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[dump-cookies] 检测到 ${shops.length} 店: ${shops.map((s) => s.shopTitle).join('、')}`);

  const rows = [];
  for (const shop of shops) {
    const title = shop.shopTitle;
    console.log(`\n--- ${title} ---`);
    let walle = '';
    try {
      walle = await collectWalleFromCdp(shop);
    } catch (err) {
      console.log(`  CDP 采集失败: ${err.message || err}`);
    }
    const apiCookie = await collectViaLiveApi(title);
    if (apiCookie.length > walle.length) walle = apiCookie;

    const walleFile = path.join(OUT_DIR, `${safeFileName(title)}.walle.txt`);
    fs.writeFileSync(walleFile, walle, 'utf8');

    const sum = summarizeCookie(walle);
    const row = {
      shopTitle: title,
      walleFile,
      walleLen: walle.length,
      hasA1: sum.hasA1,
      hasWalle: cookieContainsWalleToken(walle),
      hasArk: cookieContainsArkToken(walle),
      keys: sum.keysPreview || extractCookieKeys(walle),
    };
    console.log(`  walle: len=${row.walleLen} a1=${row.hasA1} walle=${row.hasWalle} ark=${row.hasArk}`);
    console.log(`  文件: ${walleFile}`);
    rows.push(row);
  }

  if (WITH_ARK) {
    console.log('\n[dump-cookies] 开始换票采集 ark Cookie...');
    const { spawnSync } = require('child_process');
    spawnSync(process.execPath, [path.join(__dirname, 'harvest-ark-cookie-via-ticket.js')], {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..'),
    });
    for (const row of rows) {
      const arkSrc = path.join('tmp', 'ark-cookies-via-ticket', `${safeFileName(row.shopTitle)}.txt`);
      if (fs.existsSync(arkSrc)) {
        const ark = fs.readFileSync(arkSrc, 'utf8').trim();
        const arkFile = path.join(OUT_DIR, `${safeFileName(row.shopTitle)}.ark.txt`);
        fs.copyFileSync(arkSrc, arkFile);
        row.arkFile = arkFile;
        row.arkLen = ark.length;
        row.hasArk = cookieContainsArkToken(ark);
        row.hasWalle = cookieContainsWalleToken(ark);
      }
    }
  }

  const summary = { time: new Date().toISOString(), shopCount: rows.length, shops: rows };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`\n[dump-cookies] 汇总: tmp/shop-cookies/summary.json`);
}

main().catch((err) => {
  console.error('[dump-cookies] FAILED', err.message || err);
  process.exit(1);
});
