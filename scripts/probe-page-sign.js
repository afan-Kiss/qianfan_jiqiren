#!/usr/bin/env node
const config = require('../src/wechat/wxbot-new-config');
const { ensureQianfanClientDebugReady } = require('../src/qianfan-client-launcher');
const { runQianfanShopAttachReport } = require('../src/qianfan-debug-launcher');
const { startQianfanMessageListener } = require('../src/qianfan-message-listener');
const { findBridgeByShopTitle } = require('../src/qianfan-ws-bridge');
const { cdpRuntimeEvaluate } = require('../src/cdp-timeout');

async function main() {
  const qianfanCfg = { ...config.qianfanDebug, root: config.root };
  await ensureQianfanClientDebugReady(qianfanCfg);
  const attach = await runQianfanShopAttachReport(qianfanCfg);
  await startQianfanMessageListener({
    ...qianfanCfg,
    shopReport: attach.shopReport,
    pages: attach.shopReport?.shops,
    onBuyerMessage: () => {},
  });
  await new Promise((r) => setTimeout(r, 5000));
  const bridge = findBridgeByShopTitle('祥钰珠宝');
  const { Runtime } = bridge.client;
  const r = await cdpRuntimeEvaluate(Runtime, {
    expression: `(function(){
      const keys = Object.keys(window).filter(k=>/sign|Sign|xhs|edith|axios|request/i.test(k)).slice(0,50);
      const webpack = Object.keys(window).filter(k=>k.startsWith('webpackChunk'));
      return { keys, hasAxios: !!window.axios, location: location.href, webpack };
    })()`,
    returnByValue: true,
  });
  console.log(JSON.stringify(r?.result?.value, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
