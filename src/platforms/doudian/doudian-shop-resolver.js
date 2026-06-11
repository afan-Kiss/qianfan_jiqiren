const { pickFirst } = require('./doudian-shop-utils');
const { WORKSPACE_URL_PATTERN } = require('./doudian-asar-patch-constants');

const NOISE_SHOP_NAMES = /^(首页|抖店|飞鸽|客服|实时|工作台|飞鸽客服系统|抖店工作台)$/;

const KNOWN_NAME_TOKENS = {
  263636465: ['XY', '祥钰', 'XY祥钰'],
  276595872: ['梵诗', '梵诗娅'],
};

function normalizeShopText(value) {
  return String(value || '').trim().replace(/\s+/g, '');
}

function createShopResolver(knownShops = []) {
  const byId = new Map();
  const byName = new Map();
  for (const ks of knownShops) {
    if (ks.shopId) byId.set(String(ks.shopId), ks);
    if (ks.shopName) byName.set(normalizeShopText(ks.shopName), ks);
  }
  const partitionToShopId = new Map();

  function registerPartitionMapping(partitionKey, shopId) {
    const partition = String(partitionKey || '').trim();
    const id = String(shopId || '').trim();
    if (partition && id) partitionToShopId.set(partition, id);
  }

  function matchByName(shopName) {
    const name = normalizeShopText(shopName);
    if (!name || NOISE_SHOP_NAMES.test(name)) return null;
    if (byName.has(name)) return byName.get(name);

    for (const ks of knownShops) {
      const knownName = normalizeShopText(ks.shopName);
      if (!knownName) continue;
      if (name === knownName) return ks;
      if (name.includes(knownName) || knownName.includes(name) && name.length >= 2) return ks;
    }

    for (const ks of knownShops) {
      const tokens = KNOWN_NAME_TOKENS[ks.shopId] || [];
      for (const token of tokens) {
        if (token && name.includes(token)) return ks;
      }
    }
    return null;
  }

  function buildResult(shopId, shopName, sources, recognized) {
    const id = String(shopId);
    const known = byId.get(id);
    const resolvedName = shopName || known?.shopName || '';
    return {
      shopId: id,
      shopName: resolvedName,
      shopKey: `shop:${id}`,
      recognized,
      sources: [...new Set(sources.filter(Boolean))],
    };
  }

  function resolve(input = {}) {
    const sources = [];
    let shopId = pickFirst(input.shopId, input.activeShopIdFromDom);
    let shopName = pickFirst(input.shopName, input.activeShopNameFromDom);
    const partition = pickFirst(input.sessionPartitionKey);
    const bridgeId = pickFirst(input.bridgeId);

    if (shopId) {
      const id = String(shopId);
      if (byId.has(id)) {
        const ks = byId.get(id);
        if (!shopName) shopName = ks.shopName;
        if (input.source) sources.push(input.source);
        if (partition) registerPartitionMapping(partition, id);
        return buildResult(id, shopName, sources, true);
      }
      if (input.source) sources.push(input.source);
      if (partition) registerPartitionMapping(partition, id);
      return buildResult(id, shopName, sources, true);
    }

    if (partition && partitionToShopId.has(partition)) {
      const mappedId = partitionToShopId.get(partition);
      const ks = byId.get(mappedId);
      if (!shopName && ks) shopName = ks.shopName;
      sources.push('partition_map');
      if (input.source) sources.push(input.source);
      return buildResult(mappedId, shopName, sources, true);
    }

    const known = matchByName(shopName);
    if (known) {
      sources.push('knownShops');
      if (input.source) sources.push(input.source);
      if (partition) registerPartitionMapping(partition, known.shopId);
      return buildResult(known.shopId, known.shopName, sources, true);
    }

    return {
      shopId: '',
      shopName: shopName || '',
      shopKey: partition
        ? `partition:${partition}`
        : bridgeId
          ? `unknown:${bridgeId}`
          : 'unknown:global',
      recognized: false,
      sources,
      sessionPartitionKey: partition || '',
    };
  }

  return {
    resolve,
    registerPartitionMapping,
    matchByName,
    getPartitionMap: () => partitionToShopId,
  };
}

function isImWorkspaceHref(href) {
  return String(href || '').includes(WORKSPACE_URL_PATTERN);
}

function isImBridgeActive(bridge, heartbeatTimeoutMs = 90000, now = Date.now()) {
  const heartbeatOk =
    bridge.lastHeartbeatAt && now - bridge.lastHeartbeatAt <= heartbeatTimeoutMs;
  return Boolean(bridge.observerReady || heartbeatOk || bridge.heartbeatCount > 0);
}

module.exports = {
  createShopResolver,
  isImWorkspaceHref,
  isImBridgeActive,
  NOISE_SHOP_NAMES,
};
