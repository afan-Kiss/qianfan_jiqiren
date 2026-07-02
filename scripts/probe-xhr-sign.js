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
  await bridge.client.Page.navigate({ url: 'https://walle.xiaohongshu.com/cstools/tools/packages' });
  await new Promise((r) => setTimeout(r, 8000));

  const key = 'MOBILE.+grDYt957nwwQZGJB2ipvQ==';
  const pid = 'P798528439215268621';

  const xhr = await evalPage(
    bridge,
    `(function(){
      return new Promise((resolve) => {
        const url = 'https://walle.xiaohongshu.com/api/edith/walle/get_sensitive_info?sensitiveKey=' + encodeURIComponent(${JSON.stringify(key)});
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.withCredentials = true;
        xhr.onload = () => resolve({ status: xhr.status, text: String(xhr.responseText||'').slice(0,300) });
        xhr.onerror = () => resolve({ status: 0, err: 'xhr error' });
        xhr.send();
      });
    })()`
  );
  console.log('xhr mobile', JSON.stringify(xhr, null, 2));

  const eva = await evalPage(
    bridge,
    `(function(){
      return new Promise((resolve) => {
        const url = 'https://eva.xiaohongshu.com/api/edith/get/package/decrypt?packageId=' + encodeURIComponent(${JSON.stringify(pid)});
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.withCredentials = true;
        xhr.onload = () => resolve({ status: xhr.status, text: String(xhr.responseText||'').slice(0,300) });
        xhr.send();
      });
    })()`
  );
  console.log('xhr decrypt', JSON.stringify(eva, null, 2));

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
