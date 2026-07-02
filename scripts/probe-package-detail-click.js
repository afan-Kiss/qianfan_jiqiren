#!/usr/bin/env node
const config = require('../src/wechat/wxbot-new-config');
const { ensureQianfanClientDebugReady } = require('../src/qianfan-client-launcher');
const { runQianfanShopAttachReport } = require('../src/qianfan-debug-launcher');
const { startQianfanMessageListener } = require('../src/qianfan-message-listener');
const { findBridgeByShopTitle } = require('../src/qianfan-ws-bridge');
const { cdpRuntimeEvaluate } = require('../src/cdp-timeout');
const { cdpNetworkEnable } = require('../src/cdp-timeout');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const shop = process.argv[2] || '和田雅玉';
  const packageId = process.argv[3] || 'P798535845792448171';
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
  const { Page, Network, DOM, Runtime } = bridge.client;
  await cdpNetworkEnable(Network);
  const hits = [];
  Network.responseReceived(async (params) => {
    const url = String(params.response?.url || '');
    if (!url.includes('get_sensitive_info') && !url.includes('package/decrypt')) return;
    let body = '';
    try {
      const got = await Network.getResponseBody({ requestId: params.requestId });
      body = got.base64Encoded ? Buffer.from(got.body, 'base64').toString('utf8') : got.body;
    } catch {}
    hits.push({ url, status: params.response?.status, body });
  });

  await Page.navigate({ url: `https://walle.xiaohongshu.com/cstools/tools/packages/${packageId}` });
  await sleep(8000);

  const domInfo = await cdpRuntimeEvaluate(Runtime, {
    expression: `(function(){
      const texts = [];
      document.querySelectorAll('button, a, span, div, i, svg').forEach(el => {
        const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
        if (/手机|电话|查看|解密|隐藏|显示|eye|mobile|phone/i.test(t) || (t && t.length < 8 && /\\*/.test(t))) {
          texts.push({ tag: el.tagName, t, cls: String(el.className||'').slice(0,60) });
        }
      });
      const masked = [];
      document.querySelectorAll('*').forEach(el => {
        const t = (el.innerText||'').trim();
        if (/\\d{3}\\*{3}\\d{4}/.test(t) && t.length < 30) masked.push(t);
      });
      return { href: location.href, texts: texts.slice(0,30), masked: [...new Set(masked)].slice(0,10) };
    })()`,
    returnByValue: true,
  });
  console.log('dom', JSON.stringify(domInfo?.result?.value, null, 2));

  const clickRes = await cdpRuntimeEvaluate(Runtime, {
    expression: `(function(){
      const candidates = [...document.querySelectorAll('span,div,i,svg,button')].filter(el => {
        const t = (el.innerText||el.getAttribute('aria-label')||'').trim();
        return /查看|显示|解密|眼睛|phone|mobile/i.test(t) || el.className && /eye|view|decrypt|sensitive/i.test(String(el.className));
      });
      if (!candidates.length) {
        const star = [...document.querySelectorAll('*')].find(el => /\\d{3}\\*{3}\\d{4}/.test((el.innerText||'').trim()));
        if (star) { star.click(); return { clicked: 'masked-phone', text: star.innerText }; }
        return { clicked: false, count: 0 };
      }
      candidates[0].click();
      return { clicked: true, text: candidates[0].innerText || candidates[0].className };
    })()`,
    returnByValue: true,
  });
  console.log('click', JSON.stringify(clickRes?.result?.value, null, 2));
  await sleep(5000);
  console.log('hits', JSON.stringify(hits, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
