#!/usr/bin/env node
/**
 * 全自动：开启协议抓包 → 接入千帆 CDP → 本地 API → UI 探针饭饭 → 定时打包 → 纯协议导出/测试
 * 无需手动改配置或点客服台（探针仅向饭饭发「亲亲」唤醒 WS）
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
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
} = require('../src/capture/qianfan-protocol-tap');
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
const { resolveProjectRoot } = require('../src/shared/app-root');

const CONFIG_FILE = path.join(resolveProjectRoot(), 'config.wxbot-new.json');
const DEFAULT_SHOP = '祥钰珠宝';
const BUNDLE_INTERVAL_MS = 2 * 60 * 1000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureProtocolTapInConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cfg.qianfanDebug = cfg.qianfanDebug || {};
    if (cfg.qianfanDebug.protocolTapEnabled === true) return false;
    cfg.qianfanDebug.protocolTapEnabled = true;
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    println('[协议抓包] 已自动写入 config.wxbot-new.json → qianfanDebug.protocolTapEnabled=true');
    return true;
  } catch (err) {
    println(`[协议抓包] 写入配置失败：${err.message || err}`);
    return false;
  }
}

function pickTargetShop() {
  return String(process.env.QIANFAN_PROTOCOL_TAP_SHOP || DEFAULT_SHOP).trim() || DEFAULT_SHOP;
}

async function waitForBridges(minCount = 1, timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const bridges = getAllQianfanBridges();
    if (bridges.length >= minCount) return bridges;
    await sleep(2000);
  }
  return getAllQianfanBridges();
}

async function autoExportShop(shopTitle) {
  const snapshot = await enrichAndBuildQianfanProtocolSnapshot(shopTitle, { cookieWaitMs: 3000 });
  if (!snapshot.ok) {
    println(`[协议抓包] ${shopTitle} live 导出失败：${snapshot.error || 'unknown'}`);
    return null;
  }
  const liveCfg = buildLiveProtocolConfig(snapshot, { shopTitle, buyerNick: '饭饭' });
  let existingAll = readExistingLocalConfig();
  disableFixtureShops(existingAll, shopTitle);
  const merged = mergeShopIntoLocal(existingAll, liveCfg.config, shopTitle, false);
  saveLocalProtocolConfig(merged.shops);
  println(`[协议抓包] ${shopTitle} 已合并到 config/qianfan-protocol-shops.local.json`);
  return snapshot;
}

async function autoUiProbeShop(shopTitle) {
  const bridge = findBridgeByShopTitle(shopTitle);
  if (!bridge?.client) {
    println(`[协议抓包] ${shopTitle} 无 CDP bridge，跳过 UI 探针`);
    return;
  }
  const qd = config.qianfanDebug || {};
  const buyerNick = String(qd.wsWakeBuyerNick || '饭饭').trim() || '饭饭';
  const text = String(qd.wsWakeText || '亲亲').trim() || '亲亲';
  println(`[协议抓包] ${shopTitle} 自动 UI 探针 → ${buyerNick}：${text}`);
  const sent = await sendBuyerTextViaUi(bridge.client, { appCid: '', text, buyerNick });
  println(`[协议抓包] ${shopTitle} UI 探针结果：${sent.ok ? 'ok' : sent.reason || 'fail'}`);
}

function runProtocolAuto(shopTitle, cookie) {
  const script = path.join(__dirname, 'run-qianfan-protocol-auto.js');
  println(`[协议抓包] 启动纯协议自动测试 shop=${shopTitle}`);
  const env = { ...process.env, QIANFAN_PROTOCOL_TAP: '1' };
  if (cookie) env.QIANFAN_PROTOCOL_COOKIE = cookie;
  const child = spawn(process.execPath, [script, '--shop', shopTitle], {
    cwd: resolveProjectRoot(),
    stdio: 'inherit',
    env,
  });
  child.on('exit', (code) => {
    println(`[协议抓包] 纯协议自动测试结束 exit=${code}`);
  });
}

async function main() {
  process.env.QIANFAN_PROTOCOL_TAP = '1';
  ensureProtocolTapInConfig();

  const shopTitle = pickTargetShop();
  const qianfanCfg = { ...config.qianfanDebug, root: config.root };

  println('');
  println('====================================');
  println('千帆协议抓包 - 全自动启动');
  println('====================================');
  println(`目标店铺：${shopTitle}`);
  println('流程：接入 CDP → 抓包 → UI 探针饭饭 → 定时打包 → 纯协议测试');
  println('====================================');
  println('');

  await ensureQianfanClientDebugReady(qianfanCfg);
  const attach = await runQianfanShopAttachReport(qianfanCfg);

  if (!attach?.canStartListener) {
    println('[协议抓包] 千帆未接入，请确认客服工作台已打开');
    process.exit(1);
  }

  await startQianfanLocalApi({ silent: false });

  await startQianfanMessageListener({
    devtoolsPort: qianfanCfg.devtoolsPort,
    devtoolsHost: qianfanCfg.devtoolsHost,
    expectedShopCount: qianfanCfg.expectedShopCount,
    shopReport: attach.shopReport,
    pages: attach.shopReport?.shops,
    onBuyerMessage: () => {},
  });

  logProtocolTapStartup();
  println('[协议抓包] CDP 监听已启动，等待店铺 bridge...');

  const bridges = await waitForBridges(1, 120000);
  println(`[协议抓包] 已注册 ${bridges.length} 个店铺 bridge：${bridges.map((b) => b.shopTitle).join('、')}`);

  await sleep(5000);
  const snapshot = await autoExportShop(shopTitle);
  const cookie = String(snapshot?.cookieSources?.mergedNetworkHeaderCookie || '').trim();
  await autoUiProbeShop(shopTitle);
  await sleep(15000);

  const firstBundle = bundleProtocolTap({ sinceMs: 5 * 60 * 1000 });
  if (firstBundle.ok) {
    println(`[协议抓包] 首次打包 ${firstBundle.rowCount} 条 → ${firstBundle.outPath}`);
  }

  runProtocolAuto(shopTitle, cookie);

  setInterval(() => {
    const status = getProtocolTapStatus();
    println(
      `[协议抓包] 心跳 enabled=${status.enabled} shops=${status.shops.length} log=${status.logPath}`
    );
    const bundled = bundleProtocolTap({ sinceMs: 10 * 60 * 1000 });
    if (bundled.ok && bundled.rowCount > 0) {
      println(`[协议抓包] 定时打包 ${bundled.rowCount} 条 → ${bundled.outPath}`);
    }
  }, BUNDLE_INTERVAL_MS);

  println('');
  println('[协议抓包] 全自动模式运行中，本窗口请保持打开');
  println('[协议抓包] 抓包日志：logs/debug/qianfan-protocol-tap-*.jsonl');
  println('[协议抓包] 按 Ctrl+C 退出');
  println('');
}

main().catch((err) => {
  println(`[协议抓包] 启动失败：${err.message || err}`);
  process.exit(1);
});
