/**
 * 通过千帆页面 CDP 内 fetch 发请求（浏览器自动带 Cookie + 签名）
 */
const { findBridgeByShopTitle, getAllQianfanBridges, isBridgeCdpReady } = require('../qianfan-ws-bridge');
const { cdpRuntimeEvaluate } = require('../cdp-timeout');

function pickBridge(shopTitle) {
  const direct = findBridgeByShopTitle(shopTitle);
  if (direct && isBridgeCdpReady(direct)) return direct;
  const all = getAllQianfanBridges();
  return all.find((b) => isBridgeCdpReady(b)) || null;
}

async function fetchJsonViaCdp(shopTitle, url, method = 'GET') {
  const bridge = pickBridge(shopTitle);
  if (!bridge) {
    return { ok: false, error: 'cdp_bridge_not_ready' };
  }
  const { Runtime } = bridge.client;
  try {
    const result = await cdpRuntimeEvaluate(Runtime, {
      expression: `(async function(){
        try {
          const res = await fetch(${JSON.stringify(url)}, {
            method: ${JSON.stringify(method)},
            credentials: 'include',
          });
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch (e) {}
          return { ok: res.ok, status: res.status, text, json };
        } catch (e) {
          return { ok: false, error: String(e.message || e) };
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const value = result?.result?.value;
    if (!value) return { ok: false, error: 'cdp_no_value' };
    return { ...value, via: 'cdp', bridgeShop: bridge.shopTitle };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

module.exports = { fetchJsonViaCdp, pickBridge };
