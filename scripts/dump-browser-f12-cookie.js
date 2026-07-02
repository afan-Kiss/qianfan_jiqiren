/**
 * 尽量还原 F12 Network 请求里的 Cookie：CDP Jar + requestWillBeSentExtraInfo 嗅探
 */
const fs = require('fs');
const path = require('path');
const CDP = require('chrome-remote-interface');
const config = require('../src/wechat/wxbot-new-config');
const { fetchDevToolsJsonList, getPageTargets } = require('../src/devtools-list');
const { detectQianfanShopPages } = require('../src/page-finder');
const { registerQianfanWsBridge } = require('../src/qianfan-ws-bridge');
const {
  collectFullCookiesFromBridge,
  cookieContainsArkToken,
  cookieContainsA1,
  cookieContainsWalleToken,
  mergeCookiePartsPreferLongest,
  extractCookieKeys,
} = require('../src/qianfan-full-cookie-collect');

const SNIFF_MS = Number(process.argv[2] || 12000);
const PORT = Number(process.argv[3] || config.qianfanDebug?.devtoolsPort || 9322);

function summarize(cookie, label) {
  return {
    label,
    len: cookie.length,
    a1: cookieContainsA1(cookie),
    walle: cookieContainsWalleToken(cookie),
    ark: cookieContainsArkToken(cookie),
    keys: extractCookieKeys(cookie),
  };
}

async function sniffExtraInfo(client, ms) {
  await client.Network.enable();
  const chunks = [];
  const urls = [];
  const onExtra = (params) => {
    const assoc = params?.associatedCookies;
    if (!Array.isArray(assoc) || !assoc.length) return;
    const parts = assoc
      .map((row) => {
        const c = row?.cookie || row;
        if (!c?.name) return '';
        return `${c.name}=${c.value || ''}`;
      })
      .filter(Boolean);
    if (!parts.length) return;
    chunks.push(parts.join('; '));
    urls.push(String(params?.headers?.[':path'] || params?.requestId || 'extra'));
  };
  if (client.Network.requestWillBeSentExtraInfo) {
    client.Network.requestWillBeSentExtraInfo(onExtra);
  }
  await new Promise((r) => setTimeout(r, ms));
  const merged = mergeCookiePartsPreferLongest(...chunks);
  return { cookie: merged, hitCount: chunks.length, urls: urls.slice(0, 8) };
}

async function collectShop(shop) {
  let client;
  try {
    client = await CDP({ target: shop.webSocketDebuggerUrl });
    const bridge = await registerQianfanWsBridge(shop, client);
    const jar = await collectFullCookiesFromBridge(bridge, {
      readOnly: true,
      requireRecentNetworkHeader: false,
      networkHeaderWaitMs: 2000,
      includeJarFallback: true,
      logDiagnostics: false,
    });
    const sniff = await sniffExtraInfo(client, SNIFF_MS);
    const merged = mergeCookiePartsPreferLongest(jar?.cookie || '', sniff.cookie);
    return {
      shop: shop.shopTitle,
      jar: summarize(jar?.cookie || '', 'jar'),
      sniff: summarize(sniff.cookie, 'extraInfo'),
      merged: summarize(merged, 'merged'),
      sniffHits: sniff.hitCount,
      cookie: merged,
    };
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

async function tryPort(port) {
  try {
    const list = await fetchDevToolsJsonList(port, '127.0.0.1');
    return { port, list };
  } catch (err) {
    return { port, error: err.message || String(err) };
  }
}

async function main() {
  console.log(`\n=== F12 风格 Cookie 采集 (port=${PORT}, sniff=${SNIFF_MS}ms) ===`);
  console.log('提示: 嗅探期间请在千帆里再点一次会请求 ark 的界面（订单/品退等）\n');

  const probe = await tryPort(PORT);
  if (probe.error) {
    console.error(`DevTools ${PORT} 不可用:`, probe.error);
    process.exit(1);
  }

  const report = detectQianfanShopPages(getPageTargets(probe.list), { expectedShopCount: 4 });
  const shops = report.shops.length ? report.shops : getPageTargets(probe.list).slice(0, 3);
  const rows = [];
  for (const shop of shops) {
    try {
      rows.push(await collectShop(shop));
    } catch (err) {
      console.log(`[skip] ${shop.shopTitle || shop.title}: ${err.message || err}`);
    }
  }

  for (const row of rows) {
    console.log(`\n--- ${row.shop} ---`);
    console.log(' jar   ', JSON.stringify(row.jar));
    console.log(' sniff ', JSON.stringify({ ...row.sniff, hits: row.sniffHits }));
    console.log(' merged', JSON.stringify(row.merged));
  }

  const best =
    rows.filter((r) => r.cookie).sort((a, b) => {
      if (a.merged.ark !== b.merged.ark) return a.merged.ark ? -1 : 1;
      return b.merged.len - a.merged.len;
    })[0] || null;

  if (!best?.cookie) {
    console.log('\n未采集到 Cookie');
    process.exit(1);
  }

  const out = path.join('tmp', 'f12-cookie-latest.txt');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, best.cookie, 'utf8');
  console.log(`\n已写入 ${out} (来源=${best.shop}, ark=${best.merged.ark})`);

  const ext9222 = await tryPort(9222);
  if (ext9222.error) {
    console.log('\n外部浏览器 DevTools 9222 未开启 — 订单跳转的系统 Chrome 我们接不进去。');
    console.log('要抓 F12 完整 Cookie，请任选其一:');
    console.log('  1) 在系统 Chrome 打开 ark.xiaohongshu.com 登录后，F12 → Network → 任意请求 → 复制 Cookie');
    console.log('  2) 用调试端口启动 Chrome: chrome.exe --remote-debugging-port=9222 然后重跑本脚本 --port 9222');
  } else {
    console.log('\n检测到 9222 有 DevTools，可再跑: node scripts/dump-browser-f12-cookie.js 12000 9222');
  }

  process.exit(best.merged.ark ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
