/**
 * 千帆三店：walle 换 ST 票 → 页面 SSO → 采集 ark Cookie → 探针品退接口
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const CDP = require('chrome-remote-interface');
const config = require('../src/wechat/wxbot-new-config');
const { fetchDevToolsJsonList, getPageTargets } = require('../src/devtools-list');
const { detectQianfanShopPages } = require('../src/page-finder');
const {
  mergeCdpCookieEntries,
  cookieContainsArkToken,
  cookieContainsA1,
  extractCookieKeys,
} = require('../src/qianfan-full-cookie-collect');
const { resolveXhsSignerPaths } = require('../src/analyst-app-path');

const SERVICE_TICKET_URL = 'https://customer.xiaohongshu.com/api/cas/customer/web/service-ticket';
const ARK_ROOT = 'https://ark.xiaohongshu.com';
const QUALITY_REFERER = `${ARK_ROOT}/app-violation/quality-negative-feedback`;

function getSignerPaths() {
  const sc = config.shopCookieUpload || {};
  return resolveXhsSignerPaths({ analystAppRoot: sc.analystAppRoot });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeFileName(name) {
  return String(name || 'shop')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 60);
}

function cookieForSigning(walleCookie) {
  const walleTok = (walleCookie.match(/access-token-walle\.xiaohongshu\.com=([^;]+)/) || [])[1] || '';
  if (!walleTok) return walleCookie;
  const arkPlaceholder = walleTok.replace(/^customer\.eva\./, 'customer.ark.');
  return `${walleCookie}; access-token-ark.xiaohongshu.com=${arkPlaceholder}`;
}

function signServiceTicket(walleCookie, body) {
  const { python, signerScript } = getSignerPaths();
  const input = JSON.stringify({
    method: 'POST',
    url: SERVICE_TICKET_URL,
    body,
    cookie: cookieForSigning(walleCookie),
    xsec_appid: 'walle',
  });
  const r = spawnSync(python, [signerScript], { input, encoding: 'utf8' });
  if (r.error) throw r.error;
  let parsed;
  try {
    parsed = JSON.parse(r.stdout || '{}');
  } catch {
    throw new Error(`签名脚本输出异常: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
  }
  if (!parsed.ok || !parsed.headers) {
    throw new Error(parsed.message || '签名失败');
  }
  return parsed.headers;
}

async function fetchServiceTicket(walleCookie) {
  const body = { service: ARK_ROOT, type: 'at' };
  const signed = signServiceTicket(walleCookie, body);
  const res = await fetch(SERVICE_TICKET_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
      origin: 'https://walle.xiaohongshu.com',
      referer: 'https://walle.xiaohongshu.com/cstools/seller/dashboard',
      cookie: walleCookie,
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'x-s': signed['x-s'],
      'x-t': signed['x-t'],
      'x-s-common': signed['x-s-common'],
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  const ticket = String(data?.data?.ticket || data?.ticket || '').trim();
  if (!ticket.startsWith('ST-')) {
    throw new Error(`换票失败 HTTP ${res.status} ${JSON.stringify(data).slice(0, 180)}`);
  }
  return ticket;
}

async function readMergedJar(client) {
  await client.Network.enable();
  const all = await client.Network.getAllCookies();
  return mergeCdpCookieEntries(all?.cookies || []).cookie || '';
}

async function harvestArkCookieForShop(shop) {
  let client;
  const restoreUrl = shop.url || 'https://walle.xiaohongshu.com/cstools/seller/dashboard';
  try {
    client = await CDP({ target: shop.webSocketDebuggerUrl });
    await client.Page.enable();

    const walleCookie = await readMergedJar(client);
    if (!cookieContainsA1(walleCookie)) {
      throw new Error('工作台 Cookie 缺少 a1，请确认店铺已登录');
    }

    const ticket = await fetchServiceTicket(walleCookie);
    const ssologinUrl = `${ARK_ROOT}/app-sso/ssologin?${new URLSearchParams({
      service: QUALITY_REFERER,
      ticket,
    }).toString()}`;

    await client.Page.navigate({ url: ssologinUrl });
    await sleep(5000);
    await client.Page.navigate({ url: QUALITY_REFERER });
    await sleep(3000);

    const cookie = await readMergedJar(client);
    await client.Page.navigate({ url: restoreUrl });

    return {
      shopTitle: shop.shopTitle,
      ok: true,
      ticketPreview: `${ticket.slice(0, 28)}...`,
      cookie,
      len: cookie.length,
      hasA1: cookieContainsA1(cookie),
      hasArk: cookieContainsArkToken(cookie),
      keys: extractCookieKeys(cookie),
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

function probeQualityApi(cookieFile, shopTitle) {
  const { qualityProbeScript, serverRoot } = getSignerPaths();
  const r = spawnSync('npx', ['tsx', qualityProbeScript, cookieFile], {
    cwd: serverRoot,
    encoding: 'utf8',
    shell: true,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const signOk = /signOk:\s*true/.test(out);
  const qualityOk = /qualityApiOk:\s*true/.test(out);
  const errMatch = out.match(/qualityApiError:\s*(.+)/) || out.match(/errorReason:\s*(\S+)/);
  return {
    shopTitle,
    signOk,
    qualityApiOk: qualityOk,
    exitCode: r.status ?? 1,
    detail: errMatch?.[1]?.trim() || '',
  };
}

async function main() {
  const port = config.qianfanDebug?.devtoolsPort || 9322;
  const host = config.qianfanDebug?.devtoolsHost || '127.0.0.1';
  const list = await fetchDevToolsJsonList(port, host);
  const report = detectQianfanShopPages(getPageTargets(list), { expectedShopCount: 4 });
  const shops = report.shops;

  if (!shops.length) {
    console.error('未找到千帆工作台，请先打开店铺工作台');
    process.exit(1);
  }

  console.log('\n=== 换票采集 ark Cookie（多店）===');
  console.log('流程: walle换ST票 → 页面SSO → 读Cookie → 品退探针');
  console.log('店铺:', shops.map((s) => s.shopTitle).join(' | '));
  console.log('注意: 每店会短暂跳转 ark 品退页后回到工作台\n');

  const outDir = path.join('tmp', 'ark-cookies-via-ticket');
  fs.mkdirSync(outDir, { recursive: true });

  const harvested = [];
  for (const shop of shops) {
    console.log(`--- ${shop.shopTitle} ---`);
    try {
      const row = await harvestArkCookieForShop(shop);
      const file = path.join(outDir, `${safeFileName(row.shopTitle)}.txt`);
      fs.writeFileSync(file, row.cookie, 'utf8');
      harvested.push({ ...row, file });
      console.log(`  换票: ${row.ticketPreview}`);
      console.log(`  Cookie: len=${row.len} a1=${row.hasA1} ark=${row.hasArk}`);
      console.log(`  文件: ${file}`);
      console.log(`  keys: ${row.keys.join(', ')}`);
    } catch (err) {
      harvested.push({ shopTitle: shop.shopTitle, ok: false, error: err.message || String(err) });
      console.log(`  失败: ${err.message || err}`);
    }
  }

  console.log('\n=== 品退接口探针 ===');
  const probes = [];
  for (const row of harvested.filter((r) => r.ok && r.cookie)) {
    const probe = probeQualityApi(path.resolve(row.file), row.shopTitle);
    probes.push(probe);
    console.log(`\n${row.shopTitle}: signOk=${probe.signOk} qualityApiOk=${probe.qualityApiOk}`);
    if (probe.detail) console.log(`  ${probe.detail.slice(0, 220)}`);
  }

  const summary = {
    time: new Date().toISOString(),
    shops: harvested.map((r) => ({
      shopTitle: r.shopTitle,
      ok: r.ok,
      file: r.file || null,
      len: r.len,
      hasArk: r.hasArk,
      keys: r.keys,
      error: r.error || null,
    })),
    probes,
  };
  const summaryPath = path.join(outDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n汇总: ${summaryPath}`);

  const okCount = probes.filter((p) => p.qualityApiOk).length;
  console.log(`\n结果: ${okCount}/${probes.length} 店品退接口可用`);
  process.exit(okCount === probes.length && probes.length > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
