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
  const key = 'MOBILE.+grDYt957nwwQZGJB2ipvQ==';
  const pid = 'P798528439215268621';

  const blink = await evalPage(
    bridge,
    `(async function(){
      const br = window.blinkRequest;
      if (!br) return { err: 'no blinkRequest', type: typeof br };
      const info = { type: typeof br, keys: Object.keys(br||{}).slice(0,20), proto: Object.getOwnPropertyNames(Object.getPrototypeOf(br||{})).slice(0,20) };
      return info;
    })()`
  );
  console.log('blinkRequest', JSON.stringify(blink, null, 2));

  const xhrTest = await evalPage(
    bridge,
    `(async function(){
      const key = ${JSON.stringify(key)};
      const url = 'https://walle.xiaohongshu.com/api/edith/walle/get_sensitive_info?sensitiveKey=' + encodeURIComponent(key);
      try {
        const res = await window.blinkRequest({ url, method: 'GET' });
        return { ok: true, res: typeof res === 'object' ? res : String(res).slice(0,300) };
      } catch (e) {
        return { ok: false, err: String(e.message||e), stack: String(e.stack||'').slice(0,400) };
      }
    })()`
  );
  console.log('blink sensitive', JSON.stringify(xhrTest, null, 2));

  const decryptTest = await evalPage(
    bridge,
    `(async function(){
      const pid = ${JSON.stringify(pid)};
      const url = 'https://eva.xiaohongshu.com/api/edith/get/package/decrypt?packageId=' + encodeURIComponent(pid);
      try {
        const res = await window.blinkRequest({ url, method: 'GET' });
        return { ok: true, res };
      } catch (e) {
        return { ok: false, err: String(e.message||e) };
      }
    })()`
  );
  console.log('blink decrypt', JSON.stringify(decryptTest, null, 2));

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
