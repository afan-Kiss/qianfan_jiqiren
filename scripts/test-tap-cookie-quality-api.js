/**
 * 从千帆 DevTools 采集 Cookie 并调用主播分析系统品退探针
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const CDP = require('chrome-remote-interface');
const config = require('../src/wechat/wxbot-new-config');
const { detectQianfanShopPages } = require('../src/page-finder');
const { getPageTargets, fetchDevToolsJsonList } = require('../src/devtools-list');
const { registerQianfanWsBridge } = require('../src/qianfan-ws-bridge');
const {
  collectFullCookiesFromBridge,
  cookieContainsArkToken,
  cookieContainsA1,
  cookieContainsWalleToken,
} = require('../src/qianfan-full-cookie-collect');
const { collectGlobalTapCookies } = require('../src/capture/qianfan-protocol-tap-global');

async function collectFromDevtools() {
  const port = config.qianfanDebug?.devtoolsPort || 9322;
  const host = config.qianfanDebug?.devtoolsHost || '127.0.0.1';
  const list = await fetchDevToolsJsonList(port, host);
  const report = detectQianfanShopPages(getPageTargets(list), { expectedShopCount: 4 });
  if (!report.shops.length) return null;
  const page = report.shops.find((p) => /祥钰/.test(p.shopTitle || '')) || report.shops[0];
  let client;
  try {
    client = await CDP({ target: page.webSocketDebuggerUrl });
    const bridge = await registerQianfanWsBridge(page, client);
    return collectFullCookiesFromBridge(bridge, {
      readOnly: true,
      requireRecentNetworkHeader: false,
      networkHeaderWaitMs: 1500,
      includeJarFallback: true,
    });
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

async function main() {
  const sources = [];

  const tapFile = path.join('tmp', 'latest-tap-cookie.txt');
  if (fs.existsSync(tapFile)) {
    sources.push({ name: 'tap_snapshot', cookie: fs.readFileSync(tapFile, 'utf8').trim() });
  }

  try {
    const tapLive = await collectGlobalTapCookies();
    if (tapLive?.cookie) sources.push({ name: 'tap_live', cookie: tapLive.cookie });
  } catch {
    // tap not running
  }

  try {
    const dev = await collectFromDevtools();
    if (dev?.cookie) sources.push({ name: 'devtools_collect', cookie: dev.cookie, meta: dev });
  } catch (err) {
    console.log('[quality-test] devtools collect failed:', err.message || err);
  }

  console.log('\n=== Cookie 来源汇总 ===');
  for (const s of sources) {
    console.log(
      `${s.name}: len=${s.cookie.length} a1=${cookieContainsA1(s.cookie)} walle=${cookieContainsWalleToken(s.cookie)} ark=${cookieContainsArkToken(s.cookie)}`
    );
  }

  const best = sources.find((s) => cookieContainsArkToken(s.cookie)) || sources[0];
  if (!best?.cookie) {
    console.error('[quality-test] 无可用 Cookie');
    process.exit(1);
  }

  const out = path.join('tmp', 'quality-test-cookie.txt');
  fs.writeFileSync(out, best.cookie, 'utf8');
  console.log(`\n选用来源: ${best.name} -> ${out}`);

  const script = path.resolve('..', '主播分析软件', 'apps', 'server', 'scripts', 'dev', 'test-external-cookie-quality-api.ts');
  const cookieAbs = path.resolve(out);
  const r = spawnSync('npx', ['tsx', script, cookieAbs], {
    cwd: path.resolve('..', '主播分析软件', 'apps', 'server'),
    encoding: 'utf8',
    shell: true,
  });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  process.exit(r.status ?? 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
