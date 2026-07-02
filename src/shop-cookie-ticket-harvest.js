/**
 * 四店换票采集 ark Cookie + 本地品退接口探针（上传前校验）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const CDP = require('chrome-remote-interface');
const config = require('./wechat/wxbot-new-config');
const { fetchDevToolsJsonList, getPageTargets } = require('./devtools-list');
const { detectQianfanShopPages } = require('./page-finder');
const { hashCookie } = require('./qianfan-cookie-collector');
const {
  mergeCdpCookieEntries,
  cookieContainsArkToken,
  cookieContainsA1,
  cookieContainsWalleToken,
  extractCookieKeys,
} = require('./qianfan-full-cookie-collect');
const { resolveEffectiveDevToolsPort } = require('./shared/qianfan-devtools-port-runtime');
const { resolveXhsSignerPaths } = require('./analyst-app-path');
const { println } = require('./utils');

const CANONICAL_SHOPS = [
  { shopKey: 'xiangyu', shopName: '祥钰珠宝', matchNames: ['祥钰珠宝'] },
  { shopKey: 'xyxiangyu', shopName: 'XY祥钰珠宝', matchNames: ['XY祥钰珠宝', 'XY祥钰', 'xy祥钰'] },
  { shopKey: 'hetianyayu', shopName: '和田雅玉', matchNames: ['和田雅玉'] },
  { shopKey: 'shiyuju', shopName: '拾玉居', matchNames: ['拾玉居', '拾玉居和田玉'] },
];

function normalizePageShopTitle(pageTitle) {
  return String(pageTitle || '')
    .trim()
    .replace(/-工作台\s*$/i, '')
    .replace(/工作台\s*$/i, '')
    .trim();
}

function matchPageToShop(pageTitle) {
  const title = normalizePageShopTitle(pageTitle);
  if (!title) return null;
  let best = null;
  let bestLen = 0;
  for (const row of CANONICAL_SHOPS) {
    for (const name of row.matchNames) {
      if (title !== name && !title.includes(name)) continue;
      if (name.length > bestLen) {
        best = row;
        bestLen = name.length;
      }
    }
  }
  if (best) return best;
  const lower = title.toLowerCase();
  if (lower.includes('xy') && (lower.includes('祥钰') || lower.includes('xiangyu'))) {
    return CANONICAL_SHOPS.find((s) => s.shopKey === 'xyxiangyu') || null;
  }
  return null;
}

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
    throw new Error(parsed.message || 'xhshow 签名失败');
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

async function harvestArkCookieForShop(page) {
  let client;
  const restoreUrl = page.url || 'https://walle.xiaohongshu.com/cstools/seller/dashboard';
  const shopTitle = page.shopTitle || page.pageTitle || '';
  try {
    client = await CDP({ target: page.webSocketDebuggerUrl });
    await client.Page.enable();

    const walleCookie = await readMergedJar(client);
    if (!cookieContainsA1(walleCookie)) {
      throw new Error('工作台 Cookie 缺少 a1，请确认该店已登录');
    }

    const ticket = await fetchServiceTicket(walleCookie);
    const ssologinUrl = `${ARK_ROOT}/app-sso/ssologin?${new URLSearchParams({
      service: QUALITY_REFERER,
      ticket,
    }).toString()}`;

    println(`[Cookie采集] ${shopTitle} 换票成功 ${ticket.slice(0, 28)}...，跳转 ark SSO`);
    await client.Page.navigate({ url: ssologinUrl });
    await sleep(5000);
    await client.Page.navigate({ url: QUALITY_REFERER });
    await sleep(3000);

    const cookie = await readMergedJar(client);
    await client.Page.navigate({ url: restoreUrl });

    return {
      shopTitle,
      ok: true,
      ticketPreview: `${ticket.slice(0, 28)}...`,
      cookie,
      len: cookie.length,
      hasA1: cookieContainsA1(cookie),
      hasArk: cookieContainsArkToken(cookie),
      hasWalle: cookieContainsWalleToken(cookie),
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

function probeQualityApi(cookie, shopTitle) {
  let qualityProbeScript;
  let serverRoot;
  try {
    ({ qualityProbeScript, serverRoot } = getSignerPaths());
  } catch (err) {
    return {
      shopTitle,
      signOk: false,
      qualityApiOk: false,
      exitCode: 1,
      detail: err.message || '主播分析软件路径不可用',
      skipped: true,
    };
  }

  if (!fs.existsSync(qualityProbeScript)) {
    return {
      shopTitle,
      signOk: false,
      qualityApiOk: false,
      exitCode: 1,
      detail: `品退探针脚本不存在: ${qualityProbeScript}`,
      skipped: true,
    };
  }

  const tmpDir = path.join(os.tmpdir(), 'qianfan-cookie-probe');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `${String(shopTitle).replace(/[\\/:*?"<>|]/g, '_')}.txt`);
  fs.writeFileSync(tmpFile, cookie, 'utf8');

  const r = spawnSync('npx', ['tsx', qualityProbeScript, tmpFile], {
    cwd: serverRoot,
    encoding: 'utf8',
    shell: true,
    timeout: 60000,
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
    detail: errMatch?.[1]?.trim() || (qualityOk ? '' : out.split('\n').slice(-3).join(' ').trim()),
  };
}

function findDevToolsPageForShop(shopRow, pages) {
  for (const page of pages || []) {
    const matched = matchPageToShop(page.shopTitle || page.pageTitle || '');
    if (matched?.shopKey === shopRow.shopKey) return page;
  }
  return null;
}

async function collectAllShopCookiesViaTicket(options = {}) {
  const qd = config.qianfanDebug || {};
  const port = resolveEffectiveDevToolsPort(qd.devtoolsPort || 9322);
  const host = qd.devtoolsHost || '127.0.0.1';
  const list = await fetchDevToolsJsonList(port, host);
  const report = detectQianfanShopPages(getPageTargets(list), {
    expectedShopCount: qd.expectedShopCount || 4,
  });
  const pages = report.shops || [];

  println(`[Cookie采集] 换票模式：检测到 ${pages.length} 个千帆工作台页面`);

  const collectedByKey = {};
  const missing = [];
  const probeFailed = [];
  const harvestFailed = [];
  const logs = [];

  for (const row of CANONICAL_SHOPS) {
    const page = findDevToolsPageForShop(row, pages);
    if (!page) {
      missing.push(row.shopName);
      const msg = `${row.shopName}：未找到已打开的工作台页面`;
      logs.push(msg);
      println(`[Cookie采集] ${msg}`);
      continue;
    }

    println(`[Cookie采集] ${row.shopName} 开始换票采集…`);
    try {
      const harvested = await harvestArkCookieForShop(page);
      if (!harvested.hasArk || !harvested.hasA1) {
        const msg = `${row.shopName}：采集完成但 Cookie 不完整（a1=${harvested.hasA1} ark=${harvested.hasArk}）`;
        harvestFailed.push(row.shopName);
        collectedByKey[row.shopKey] = {
          skipped: true,
          reason: 'incomplete_cookie',
          shopName: row.shopName,
          harvestOk: false,
          message: msg,
        };
        logs.push(msg);
        println(`[Cookie采集] ${msg}`);
        continue;
      }

      println(
        `[Cookie采集] ${row.shopName} 采集成功 len=${harvested.len} keys=${harvested.keys.slice(0, 8).join(',')}…`
      );

      println(`[Cookie探针] ${row.shopName} 本地品退接口校验中…`);
      const probe = probeQualityApi(harvested.cookie, row.shopName);
      if (!probe.qualityApiOk) {
        const detail = probe.detail ? `（${probe.detail.slice(0, 120)}）` : '';
        const msg = `${row.shopName}：品退探针失败 signOk=${probe.signOk}${detail}，本次不上传`;
        probeFailed.push(row.shopName);
        collectedByKey[row.shopKey] = {
          skipped: true,
          reason: 'probe_failed',
          shopName: row.shopName,
          harvestOk: true,
          probeQualityOk: false,
          probeSignOk: probe.signOk,
          message: msg,
          probe,
        };
        logs.push(msg);
        println(`[Cookie探针] ${msg}`);
        continue;
      }

      const okMsg = `${row.shopName}：换票采集成功，品退探针通过（len=${harvested.len}）`;
      logs.push(okMsg);
      println(`[Cookie探针] ${okMsg}`);

      collectedByKey[row.shopKey] = {
        platform: 'qianfan',
        shopName: row.shopName,
        cookie: harvested.cookie,
        cookieHash: hashCookie(harvested.cookie),
        hasA1: harvested.hasA1,
        hasArk: harvested.hasArk,
        hasWalle: harvested.hasWalle,
        cookieKeyCount: harvested.keys.length,
        cookieKeys: harvested.keys,
        source: 'ticket-harvest',
        capturedAt: new Date().toISOString(),
        harvestOk: true,
        probeQualityOk: true,
        probeSignOk: probe.signOk,
        ticketPreview: harvested.ticketPreview,
      };
    } catch (err) {
      const msg = `${row.shopName}：换票采集失败 ${err.message || err}`;
      harvestFailed.push(row.shopName);
      collectedByKey[row.shopKey] = {
        skipped: true,
        reason: 'harvest_failed',
        shopName: row.shopName,
        harvestOk: false,
        message: msg,
      };
      logs.push(msg);
      println(`[Cookie采集] ${msg}`);
    }
  }

  return {
    collectedByKey,
    missing,
    incomplete: [],
    count: Object.values(collectedByKey).filter((c) => c?.cookie && !c.skipped).length,
    probeFailed,
    harvestFailed,
    logs,
  };
}

module.exports = {
  harvestArkCookieForShop,
  probeQualityApi,
  collectAllShopCookiesViaTicket,
};
