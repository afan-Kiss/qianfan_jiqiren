#!/usr/bin/env node
/**
 * 全流程协议抓包：从二维码登录开始 → 店铺接入 → WS/HTTP 全量记录
 * 目标：逆向完整登录+会话协议，最终脱离千帆客服台 UI
 */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const config = require('../src/wechat/wxbot-new-config');
const { println } = require('../src/utils');
const { ensureQianfanClientDebugReady } = require('../src/qianfan-client-launcher');
const { runQianfanShopAttachReport } = require('../src/qianfan-debug-launcher');
const { startQianfanMessageListener } = require('../src/qianfan-message-listener');
const { startQianfanLocalApi } = require('../src/qianfan-local-api');
const {
  getProtocolTapStatus,
  bundleProtocolTap,
  logProtocolTapStartup,
  tapLogPath,
  writeTapSessionManifest,
  appendTapSessionMilestone,
} = require('../src/capture/qianfan-protocol-tap');
const {
  startGlobalProtocolTap,
  stopGlobalProtocolTap,
  getGlobalProtocolTapStatus,
  collectGlobalTapCookies,
} = require('../src/capture/qianfan-protocol-tap-global');
const {
  getAllQianfanBridges,
  enrichAndBuildQianfanProtocolSnapshot,
  findBridgeByShopTitle,
} = require('../src/qianfan-ws-bridge');
const { sendBuyerTextViaUi } = require('../src/qianfan-ui-sync');
const {
  mergeShopIntoLocal,
  saveLocalProtocolConfig,
  readExistingLocalConfig,
  disableFixtureShops,
  buildLiveProtocolConfig,
} = require('../src/protocol/qianfan-live-context-extractor');
const { applyTapToShopConfig } = require('../src/protocol/qianfan-protocol-tap-config');
const { resolveProjectRoot } = require('../src/shared/app-root');

const CONFIG_FILE = path.join(resolveProjectRoot(), 'config.wxbot-new.json');
const DEFAULT_SHOP = '祥钰珠宝';
const BUNDLE_INTERVAL_MS = 2 * 60 * 1000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const out = { fresh: false, skipProbe: false, shop: DEFAULT_SHOP, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--fresh') out.fresh = true;
    else if (a === '--skip-probe') out.skipProbe = true;
    else if (a === '--shop') out.shop = String(argv[++i] || DEFAULT_SHOP).trim();
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function ensureProtocolTapInConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cfg.qianfanDebug = cfg.qianfanDebug || {};
    cfg.qianfanDebug.protocolTapEnabled = true;
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function killQianfanClientIfFresh() {
  const proc = String(config.qianfanDebug?.qianfanClientProcessName || '千帆客服工作台.exe');
  try {
    execSync(`taskkill /F /T /IM "${proc}"`, { stdio: 'ignore' });
    println(`[全流程抓包] 已结束旧千帆进程：${proc}`);
    return true;
  } catch {
    return false;
  }
}

async function waitForBridges(minCount = 1, timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const bridges = getAllQianfanBridges();
    if (bridges.length >= minCount) return bridges;
    await sleep(2000);
  }
  return getAllQianfanBridges();
}

async function autoExportShop(shopTitle) {
  const snapshot = await enrichAndBuildQianfanProtocolSnapshot(shopTitle, { cookieWaitMs: 4000 });
  if (!snapshot.ok) {
    println(`[全流程抓包] ${shopTitle} live 导出失败：${snapshot.error || 'unknown'}`);
    return null;
  }

  const globalCookie = await collectGlobalTapCookies({ reason: 'auto_export', networkHeaderWaitMs: 2000 });
  const bridgeCookie = String(snapshot.cookieSources?.mergedNetworkHeaderCookie || '').trim();
  const tapCookie = String(globalCookie?.cookie || '').trim();
  if (tapCookie && (!bridgeCookie || tapCookie.length > bridgeCookie.length)) {
    snapshot.cookieSources = {
      ...snapshot.cookieSources,
      mergedNetworkHeaderCookie: tapCookie,
      globalTapCookie: tapCookie,
    };
    snapshot.enrichNotes = [...(snapshot.enrichNotes || []), 'global_tap_cookie'];
    println(
      `[全流程抓包] ${shopTitle} 已合并全局 Cookie 快照 len=${tapCookie.length} walle=${globalCookie.summary?.hasWalleToken}`
    );
  }

  const liveCfg = buildLiveProtocolConfig(snapshot, { shopTitle, buyerNick: '饭饭' });
  let existingAll = readExistingLocalConfig();
  disableFixtureShops(existingAll, shopTitle);
  const merged = mergeShopIntoLocal(existingAll, liveCfg.config, shopTitle, false);
  saveLocalProtocolConfig(merged.shops);

  const tapApplied = applyTapToShopConfig(
    merged.shops.find((s) => s.shopTitle === shopTitle) || liveCfg.config,
    { shopTitle }
  );
  saveLocalProtocolConfig(
    merged.shops.map((s) => (s.shopTitle === shopTitle ? tapApplied.config : s))
  );
  println(`[全流程抓包] ${shopTitle} 已合并 tap 配置 → config/qianfan-protocol-shops.local.json`);
  return snapshot;
}

async function autoUiProbeShop(shopTitle) {
  const bridge = findBridgeByShopTitle(shopTitle);
  if (!bridge?.client) return;
  const qd = config.qianfanDebug || {};
  const buyerNick = String(qd.wsWakeBuyerNick || '饭饭').trim() || '饭饭';
  const text = String(qd.wsWakeText || '亲亲').trim() || '亲亲';
  println(`[全流程抓包] ${shopTitle} UI 探针 → ${buyerNick}：${text}`);
  await sendBuyerTextViaUi(bridge.client, { appCid: '', text, buyerNick });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      '用法: node scripts/run-qianfan-protocol-tap-full.js [--fresh] [--shop 祥钰珠宝] [--skip-probe]'
    );
    process.exit(0);
  }

  process.env.QIANFAN_PROTOCOL_TAP = '1';
  ensureProtocolTapInConfig();

  const qianfanCfg = { ...config.qianfanDebug, root: config.root };
  const sessionManifest = {
    startedAt: new Date().toISOString(),
    mode: 'full_login_capture',
    shopTitle: args.shop,
    freshStart: args.fresh,
    milestones: [],
  };

  println('');
  println('==================================================');
  println('千帆协议抓包 - 全流程（从二维码登录开始）');
  println('==================================================');
  println(`目标店铺：${args.shop}`);
  println('步骤：');
  println('  1. 启动全局 CDP 抓包（登录页/SSO/二维码）');
  println('  2. 启动/接入千帆客服台');
  println('  3. 请你扫码登录（如尚未登录）');
  println('  4. 打开店铺工作台后自动抓 WS/auth/send');
  println('  5. 导出 local.json + 定时打包');
  println('==================================================');
  println('');

  if (args.fresh) {
    killQianfanClientIfFresh();
    await sleep(3000);
  }

  startGlobalProtocolTap({
    devtoolsPort: qianfanCfg.devtoolsPort,
    devtoolsHost: qianfanCfg.devtoolsHost,
    pollMs: 2000,
  });
  appendTapSessionMilestone({
    milestone: 'waiting_user_login',
    message: '请现在打开/登录千帆客服台并扫码',
  });

  println('');
  println('>>> 请现在登录千帆客服台（扫码）。抓包已从登录阶段开始记录。');
  println(`>>> 日志文件：${tapLogPath()}`);
  println('');

  await ensureQianfanClientDebugReady(qianfanCfg);
  const attach = await runQianfanShopAttachReport(qianfanCfg);
  if (!attach?.canStartListener) {
    println('[全流程抓包] 千帆 DevTools 未就绪，但登录页抓包仍在进行，请完成登录后重试 attach');
  }

  await startQianfanLocalApi({ silent: false });
  logProtocolTapStartup();

  if (attach?.canStartListener) {
    await startQianfanMessageListener({
      devtoolsPort: qianfanCfg.devtoolsPort,
      devtoolsHost: qianfanCfg.devtoolsHost,
      expectedShopCount: qianfanCfg.expectedShopCount,
      shopReport: attach.shopReport,
      pages: attach.shopReport?.shops,
      onBuyerMessage: () => {},
    });
  }

  appendTapSessionMilestone({ milestone: 'listener_started', shopCount: getAllQianfanBridges().length });
  println('[全流程抓包] 等待店铺 bridge 就绪（登录后打开工作台）...');

  const bridges = await waitForBridges(1, 180000);
  println(`[全流程抓包] 店铺 bridge：${bridges.length} 个 → ${bridges.map((b) => b.shopTitle).join('、')}`);
  appendTapSessionMilestone({ milestone: 'shop_bridges_ready', bridgeCount: bridges.length });

  await sleep(5000);
  await autoExportShop(args.shop);

  if (!args.skipProbe) {
    await autoUiProbeShop(args.shop);
    appendTapSessionMilestone({ milestone: 'ui_probe_done', shopTitle: args.shop });
    await sleep(12000);
  }

  const firstBundle = bundleProtocolTap({ sinceMs: 30 * 60 * 1000 });
  if (firstBundle.ok) {
    println(`[全流程抓包] 首次打包 ${firstBundle.rowCount} 条 → ${firstBundle.outPath}`);
  }

  sessionManifest.milestones.push({
    at: new Date().toISOString(),
    globalTap: getGlobalProtocolTapStatus(),
    tapStatus: getProtocolTapStatus(),
    bundle: firstBundle.ok ? firstBundle.outPath : '',
  });
  const manifestPath = writeTapSessionManifest(sessionManifest);
  println(`[全流程抓包] 会话清单 → ${manifestPath}`);

  setInterval(() => {
    const status = getProtocolTapStatus();
    const global = getGlobalProtocolTapStatus();
    println(
      `[全流程抓包] 心跳 global=${global.attachedCount} shops=${status.shops.length} log=${status.logPath}`
    );
    const bundled = bundleProtocolTap({ sinceMs: 15 * 60 * 1000 });
    if (bundled.ok && bundled.rowCount > 0) {
      println(`[全流程抓包] 定时打包 ${bundled.rowCount} 条 → ${bundled.outPath}`);
    }
  }, BUNDLE_INTERVAL_MS);

  println('');
  println('[全流程抓包] 运行中。请保持本窗口与千帆客服台打开。');
  println('[全流程抓包] 建议操作：登录 → 打开店铺 → 手动发一条饭饭消息 → 等待打包');
  println('[全流程抓包] Ctrl+C 退出');
  println('');

  process.on('SIGINT', () => {
    void (async () => {
      await stopGlobalProtocolTap();
      process.exit(0);
    })();
  });
}

main().catch(async (err) => {
  println(`[全流程抓包] 启动失败：${err.message || err}`);
  await stopGlobalProtocolTap();
  process.exit(1);
});
