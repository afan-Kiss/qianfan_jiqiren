#!/usr/bin/env node
/** 启动 CDP 监听 → 刷新四店 Cookie */
const config = require('../src/wechat/wxbot-new-config');
const { ensureQianfanClientDebugReady } = require('../src/qianfan-client-launcher');
const { runQianfanShopAttachReport } = require('../src/qianfan-debug-launcher');
const { startQianfanMessageListener } = require('../src/qianfan-message-listener');
const { enrichAndBuildQianfanProtocolSnapshot, getAllQianfanBridges } = require('../src/qianfan-ws-bridge');
const { readExistingLocalConfig, saveLocalProtocolConfig } = require('../src/protocol/qianfan-live-context-extractor');

const SHOPS = ['祥钰珠宝', '和田雅玉', 'XY祥钰珠宝', '拾玉居和田玉'];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const qianfanCfg = { ...config.qianfanDebug, root: config.root };
  await ensureQianfanClientDebugReady(qianfanCfg);
  const attach = await runQianfanShopAttachReport(qianfanCfg);
  if (!attach?.canStartListener) {
    console.error('[refresh-cookie] 千帆 DevTools 未就绪');
    process.exit(1);
  }
  await startQianfanMessageListener({
    devtoolsPort: qianfanCfg.devtoolsPort,
    devtoolsHost: qianfanCfg.devtoolsHost,
    expectedShopCount: qianfanCfg.expectedShopCount,
    shopReport: attach.shopReport,
    pages: attach.shopReport?.shops,
    onBuyerMessage: () => {},
  });
  console.log('[refresh-cookie] 等待 bridge 与 Network Cookie...');
  await sleep(8000);
  console.log('[refresh-cookie] bridges:', getAllQianfanBridges().map((b) => b.shopTitle).join('、'));

  const all = readExistingLocalConfig();
  for (const shopTitle of SHOPS) {
    try {
      const snapshot = await enrichAndBuildQianfanProtocolSnapshot(shopTitle, { cookieWaitMs: 8000 });
      const cookie = String(snapshot?.cookieSources?.mergedNetworkHeaderCookie || '').trim();
      const idx = all.findIndex((s) => s.shopTitle === shopTitle);
      if (idx < 0) continue;
      if (!cookie || cookie.length < 100) {
        console.warn(`[refresh-cookie] ${shopTitle} Cookie 不足 len=${cookie.length} notes=${(snapshot.enrichNotes || []).join(',')}`);
        continue;
      }
      all[idx].cookie = cookie;
      console.log(`[refresh-cookie] ${shopTitle} ok len=${cookie.length}`);
    } catch (err) {
      console.warn(`[refresh-cookie] ${shopTitle}: ${err.message || err}`);
    }
  }
  saveLocalProtocolConfig(all);
  console.log('[refresh-cookie] 完成');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
