#!/usr/bin/env node
const config = require('../src/wechat/wxbot-new-config');
const { ensureQianfanClientDebugReady } = require('../src/qianfan-client-launcher');
const { runQianfanShopAttachReport } = require('../src/qianfan-debug-launcher');
const { startQianfanMessageListener } = require('../src/qianfan-message-listener');
const { findBridgeByShopTitle } = require('../src/qianfan-ws-bridge');
const { cdpRuntimeEvaluate } = require('../src/cdp-timeout');

async function evalPage(bridge, expression) {
  const { Runtime, Page } = bridge.client;
  return cdpRuntimeEvaluate(Runtime, { expression, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);
}

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
  const { Page } = bridge.client;
  await Page.navigate({ url: 'https://walle.xiaohongshu.com/cstools/tools/packages' });
  await new Promise((r) => setTimeout(r, 6000));

  const mods = await evalPage(
    bridge,
    `(function(){
      const hits = [];
      const chunk = window.webpackChunkwalle_eva;
      if (!chunk) return { err: 'no chunk' };
      try {
        chunk.push([['__qf_probe__'], {}, function(req){
          const c = req.c;
          for (const id of Object.keys(c)) {
            const exp = c[id]?.exports;
            if (!exp) continue;
            const objs = [exp];
            if (exp.default) objs.push(exp.default);
            for (const o of objs) {
              if (!o || typeof o !== 'object') continue;
              for (const k of Object.keys(o)) {
                const v = o[k];
                const lk = k.toLowerCase();
                if (/sign|edith|sensitive|decrypt|http|request|fetch|axios/i.test(k) || /sign|sensitive|decrypt/i.test(String(v))) {
                  hits.push({ id, key: k, type: typeof v, sample: String(v).slice(0,80) });
                }
              }
            }
          }
        }]);
      } catch (e) { return { err: String(e.message||e) }; }
      return { location: location.href, hits: hits.slice(0,40) };
    })()`
  );
  console.log('mods', JSON.stringify(mods, null, 2));

  const key = 'MOBILE.+grDYt957nwwQZGJB2ipvQ==';
  const fetchTest = await evalPage(
    bridge,
    `(async function(){
      const url = 'https://walle.xiaohongshu.com/api/edith/walle/get_sensitive_info?sensitiveKey=' + encodeURIComponent(${JSON.stringify(key)});
      const res = await fetch(url, { credentials: 'include' });
      const text = await res.text();
      return { status: res.status, text: text.slice(0,200), href: location.href };
    })()`
  );
  console.log('fetch on packages', JSON.stringify(fetchTest, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
