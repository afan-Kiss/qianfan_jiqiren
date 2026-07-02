#!/usr/bin/env node
const config = require('../src/wechat/wxbot-new-config');
const { ensureQianfanClientDebugReady } = require('../src/qianfan-client-launcher');
const { runQianfanShopAttachReport } = require('../src/qianfan-debug-launcher');
const { startQianfanMessageListener } = require('../src/qianfan-message-listener');
const { findBridgeByShopTitle } = require('../src/qianfan-ws-bridge');
const { cdpNetworkEnable } = require('../src/cdp-timeout');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function captureSensitiveOnPackagePage(bridge, packageId, waitMs = 12000) {
  const { Network, Page } = bridge.client;
  await cdpNetworkEnable(Network);
  const hits = [];
  const onResp = async (params) => {
    const url = String(params.response?.url || '');
    if (!url.includes('/get_sensitive_info') && !url.includes('/package/decrypt')) return;
    let body = '';
    try {
      const got = await Network.getResponseBody({ requestId: params.requestId });
      body = got.base64Encoded ? Buffer.from(got.body, 'base64').toString('utf8') : got.body;
    } catch {}
    hits.push({ url, status: params.response?.status, body: body.slice(0, 300) });
  };
  Network.responseReceived(onResp);
  const detailUrl = `https://walle.xiaohongshu.com/cstools/tools/packages/${encodeURIComponent(packageId)}`;
  await Page.navigate({ url: detailUrl });
  await sleep(waitMs);
  Network.responseReceived(null);
  return hits;
}

async function main() {
  const shop = process.argv[2] || '拾玉居和田玉';
  const packageId = process.argv[3] || 'P798528439215268621';
  const qianfanCfg = { ...config.qianfanDebug, root: config.root };
  await ensureQianfanClientDebugReady(qianfanCfg);
  const attach = await runQianfanShopAttachReport(qianfanCfg);
  await startQianfanMessageListener({
    ...qianfanCfg,
    shopReport: attach.shopReport,
    pages: attach.shopReport?.shops,
    onBuyerMessage: () => {},
  });
  await sleep(5000);
  const bridge = findBridgeByShopTitle(shop);
  if (!bridge) throw new Error(`no bridge ${shop}`);
  const hits = await captureSensitiveOnPackagePage(bridge, packageId, 15000);
  console.log(JSON.stringify(hits, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
