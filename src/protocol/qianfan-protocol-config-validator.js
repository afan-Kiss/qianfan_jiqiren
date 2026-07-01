/**
 * 千帆纯协议配置校验（守护进程 / config-agent 共用）
 */
const { resolveProtocolWsEndpoints } = require('./qianfan-protocol-ws-routing');
const { readTapRows } = require('./qianfan-protocol-tap-config');

function validateProtocolShopConfig(shop, tapRows = []) {
  const shopTitle = String(shop?.shopTitle || '').trim();
  const errors = [];
  if (!shopTitle) errors.push('缺少 shopTitle');
  if (!String(shop?.cookie || '').trim()) errors.push('缺少 cookie');
  if (!shop?.ws?.authTemplate?.body?.sid) errors.push('缺少 ws.authTemplate.body.sid');
  if (!shop?.ws?.authTemplate?.body?.uid) errors.push('缺少 ws.authTemplate.body.uid');
  if (!shop?.ws?.handshakeHeaders || !Object.keys(shop.ws.handshakeHeaders).length) {
    errors.push('缺少 ws.handshakeHeaders');
  }
  const endpoints = resolveProtocolWsEndpoints(shop, tapRows);
  if (!endpoints.sendUrl && !endpoints.apppushUrl) {
    errors.push('缺少 sendUrl/apppushUrl');
  }
  if (!endpoints.canSend) errors.push('canWsSend=false');
  if (!shop?.httpAuthHeaders?.authorization && !shop?.ws?.authTemplate?.body?.sid) {
    errors.push('缺少 httpAuthHeaders.authorization');
  }
  return {
    shopTitle,
    ok: errors.length === 0,
    errors,
    endpoints,
    canWsSend: Boolean(endpoints.canSend),
  };
}

function validateProtocolConfigShops(shops, options = {}) {
  const rows = options.tapRows || readTapRows(options.maxTapFiles || 2);
  const list = Array.isArray(shops) ? shops : [];
  const enabled = list.filter((s) => s && s.enabled !== false);
  const shopResults = enabled.map((shop) => validateProtocolShopConfig(shop, rows));
  const canWsSendCount = shopResults.filter((r) => r.canWsSend).length;
  return {
    ok: shopResults.length > 0 && canWsSendCount > 0 && shopResults.every((r) => r.ok),
    shopCount: shopResults.length,
    canWsSendCount,
    shops: shopResults,
    errors: shopResults.filter((r) => !r.ok).flatMap((r) => r.errors.map((e) => `${r.shopTitle}: ${e}`)),
  };
}

module.exports = {
  validateProtocolShopConfig,
  validateProtocolConfigShops,
};
