#!/usr/bin/env node
const config = require('../src/wechat/wxbot-new-config');
const { ensureQianfanClientDebugReady } = require('../src/qianfan-client-launcher');
const { runQianfanShopAttachReport } = require('../src/qianfan-debug-launcher');
const { startQianfanMessageListener } = require('../src/qianfan-message-listener');
const { findBridgeByShopTitle } = require('../src/qianfan-ws-bridge');
const { cdpRuntimeEvaluate } = require('../src/cdp-timeout');

async function evalPage(bridge, expression) {
  const { Runtime } = bridge.client;
  const r = await cdpRuntimeEvaluate(Runtime, { expression, awaitPromise: true, returnByValue: true });
  return r?.result?.value;
}

async function main() {
  const shop = process.argv[2] || 'XY祥钰珠宝';
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
  const bridge = findBridgeByShopTitle(shop);
  if (!bridge) throw new Error(`no bridge for ${shop}`);
  await bridge.client.Page.navigate({ url: 'https://walle.xiaohongshu.com/cstools/tools/packages' });
  await new Promise((r) => setTimeout(r, 8000));

  const hits = await evalPage(
    bridge,
    `(function(){
      const out = [];
      const chunk = window.webpackChunkwalle_eva;
      if (!chunk) return { err: 'no chunk' };
      chunk.push([['__qf_src__'], {}, function(require){
        const c = require.c || {};
        for (const id of Object.keys(c)) {
          const mod = c[id];
          let src = '';
          try { src = mod && mod.toString ? mod.toString() : ''; } catch(e) {}
          if (/get_sensitive_info|X-s|X-S-Common|package\\/decrypt|signXs|x-s-common/i.test(src)) {
            out.push({ id, len: src.length, sample: src.slice(0, 240) });
          }
        }
      }]);
      return { href: location.href, count: out.length, hits: out.slice(0, 15) };
    })()`
  );
  console.log(JSON.stringify(hits, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
