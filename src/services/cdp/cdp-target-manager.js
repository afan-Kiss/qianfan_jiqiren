const { getCdpBridgeConfig } = require('../../shared/config');
const { bridgeLog } = require('../../shared/bridge-log');
const { fetchDevToolsJsonList } = require('../../shared/devtools-probe');
const { extractShopInfo, classifyPagePlatform } = require('../../platforms/doudian/doudian-page-finder');

function matchAllowedTarget(target, cfg) {
  const url = String(target.url || '').toLowerCase();
  const title = String(target.title || '').toLowerCase();
  const hay = `${url} ${title}`;
  const allowed = (cfg.allowedUrlKeywords || []).map((k) => String(k).toLowerCase());
  const blocked = (cfg.blockedUrlKeywords || []).map((k) => String(k).toLowerCase());
  if (blocked.some((k) => k && hay.includes(k))) return false;
  if (!allowed.length) return target.type === 'page';
  return allowed.some((k) => k && hay.includes(k));
}

function buildPageKey(target) {
  return `${target.id || ''}:${target.url || ''}`;
}

function normalizeTarget(raw, index, port, host) {
  const shop = extractShopInfo(raw);
  const platform = classifyPagePlatform(raw);
  return {
    targetId: raw.id || `target-${index}`,
    sessionId: raw.id || '',
    pageKey: buildPageKey(raw),
    type: raw.type || 'page',
    title: raw.title || '',
    url: raw.url || '',
    webSocketDebuggerUrl: raw.webSocketDebuggerUrl || '',
    devtoolsPort: port,
    devtoolsHost: host,
    platform,
    shopId: shop.shopId || 'unknown',
    shopName: shop.shopName || 'unknown',
    pageTitle: raw.title || '',
    pageUrl: raw.url || '',
    accountId: 'unknown',
    sessionPartitionKey: 'unknown',
  };
}

async function discoverTargets(options = {}) {
  const cfg = getCdpBridgeConfig();
  const host = options.host || cfg.devtoolsHost || '127.0.0.1';
  const port = Number(options.port);
  if (!port) {
    return { ok: false, reason: 'missing_port', targets: [], allTargets: [] };
  }

  let list = [];
  try {
    list = await fetchDevToolsJsonList(port, host);
  } catch (err) {
    bridgeLog('[CDP_TARGET]', `获取 /json/list 失败 ${host}:${port}`, String(err.message || err));
    return { ok: false, reason: 'json_list_failed', error: String(err.message || err), targets: [], allTargets: [] };
  }

  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const matched = pages.filter((t) => matchAllowedTarget(t, cfg));
  const targets = matched.map((t, i) => normalizeTarget(t, i, port, host));

  for (const t of targets) {
    bridgeLog('[CDP_TARGET]', `识别页面 title=${t.title.slice(0, 40)} url=${t.url.slice(0, 80)} targetId=${t.targetId}`);
  }

  if (!targets.length) {
    bridgeLog('[CDP_TARGET]', `未匹配客服页，全部 page 数=${pages.length}`);
  }

  return {
    ok: targets.length > 0,
    reason: targets.length ? 'targets_found' : 'no_matching_targets',
    port,
    host,
    targets,
    allTargets: pages.map((t, i) => normalizeTarget(t, i, port, host)),
    totalPageCount: pages.length,
  };
}

module.exports = {
  discoverTargets,
  matchAllowedTarget,
  normalizeTarget,
  buildPageKey,
};
