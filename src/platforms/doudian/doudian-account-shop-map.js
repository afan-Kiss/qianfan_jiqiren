const { pickFirst } = require('./doudian-shop-utils');
const { createShopResolver, NOISE_SHOP_NAMES } = require('./doudian-shop-resolver');

function normalizeShopName(value) {
  return String(value || '').trim().replace(/\s+/g, '');
}

function extractPersistAccountId(sessionPartitionKey) {
  const key = String(sessionPartitionKey || '').trim();
  const match = key.match(/^persist:(\d{10,20})$/);
  return match ? match[1] : '';
}

function createAccountShopMap(knownShops = []) {
  const accountIdToShop = new Map();
  const partitionKeyToShop = new Map();
  const shopNameToShop = new Map();
  const shopIdToShop = new Map();
  const bridgeIdToPartitionKey = new Map();
  const bridgeIdToShop = new Map();
  const bridgeIdToLastApi = new Map();

  const knownShopIds = new Set(knownShops.map((ks) => String(ks.shopId)).filter(Boolean));
  const resolver = createShopResolver(knownShops);

  for (const ks of knownShops) {
    const entry = { shopId: String(ks.shopId), shopName: ks.shopName || '', source: 'knownShops' };
    shopIdToShop.set(entry.shopId, entry);
    if (entry.shopName) shopNameToShop.set(normalizeShopName(entry.shopName), entry);
  }

  function isKnownShopId(shopId) {
    return knownShopIds.has(String(shopId || ''));
  }

  function upsertShopEntry(info = {}, source = '') {
    const resolved = resolver.resolve({ ...info, source });
    if (!resolved.shopId || !isKnownShopId(resolved.shopId)) return null;
    const entry = {
      shopId: String(resolved.shopId),
      shopName: resolved.shopName || shopIdToShop.get(String(resolved.shopId))?.shopName || '',
      source: source || resolved.sources?.[0] || 'unknown',
      accountId: pickFirst(info.accountId, extractPersistAccountId(info.sessionPartitionKey)),
      sessionPartitionKey: pickFirst(info.sessionPartitionKey),
    };
    shopIdToShop.set(entry.shopId, entry);
    if (entry.shopName) shopNameToShop.set(normalizeShopName(entry.shopName), entry);
    if (entry.accountId) accountIdToShop.set(String(entry.accountId), entry);
    if (entry.sessionPartitionKey) partitionKeyToShop.set(String(entry.sessionPartitionKey), entry);
    if (entry.sessionPartitionKey && entry.shopId) {
      resolver.registerPartitionMapping(entry.sessionPartitionKey, entry.shopId);
    }
    return entry;
  }

  function ingestStdoutAccount(account = {}) {
    return upsertShopEntry(
      {
        shopId: account.shopId,
        shopName: account.shopName,
        accountId: account.accountId,
        sessionPartitionKey: account.sessionPartitionKey,
      },
      account.source || 'stdout_accounts'
    );
  }

  function ingestStdoutShop(shop = {}) {
    return upsertShopEntry(shop, shop.source || 'stdout_accounts');
  }

  function ingestIdentityHint(hint = {}) {
    const entry = upsertShopEntry(hint, hint.source || 'memory_cache');
    if (hint.bridgeId && entry) {
      bridgeIdToShop.set(hint.bridgeId, entry);
    }
    return entry;
  }

  function ingestMemoryCacheHint(hint = {}) {
    const partition = pickFirst(
      hint.sessionPartitionKey,
      extractPartitionFromCacheKey(hint.cacheKey)
    );
    const accountId = pickFirst(hint.accountId, extractPersistAccountId(partition));
    if (hint.bridgeId && partition) {
      bridgeIdToPartitionKey.set(hint.bridgeId, partition);
    }
    if (hint.bridgeId && hint.apiName) {
      bridgeIdToLastApi.set(hint.bridgeId, hint.apiName);
    }
    const entry = upsertShopEntry(
      {
        shopId: hint.shopId,
        shopName: hint.shopName,
        accountId,
        sessionPartitionKey: partition,
      },
      hint.source || 'memory_cache'
    );
    if (hint.bridgeId && entry) {
      bridgeIdToShop.set(hint.bridgeId, entry);
    }
    return entry;
  }

  function resolveShopForBridge(bridge = {}, bridgeHint = null) {
    const whyUnresolved = [];
    const sources = [];
    const pageInfo = {
      shopId: pickFirst(bridge.shopId, bridge.activeShopIdFromDom, bridgeHint?.shopId),
      shopName: pickFirst(bridge.shopName, bridge.activeShopNameFromDom, bridgeHint?.shopName),
      accountId: pickFirst(
        bridge.accountId,
        bridge.persistAccountId,
        bridgeHint?.accountId,
        extractPersistAccountId(bridge.sessionPartitionKey)
      ),
      sessionPartitionKey: pickFirst(
        bridge.sessionPartitionKey,
        bridgeHint?.sessionPartitionKey,
        bridgeIdToPartitionKey.get(bridge.bridgeId)
      ),
    };

    if (pageInfo.shopId && isKnownShopId(pageInfo.shopId)) {
      sources.push('pageInfo.shopId', 'knownShops');
      const entry = shopIdToShop.get(String(pageInfo.shopId));
      return {
        shopId: String(pageInfo.shopId),
        shopName: pageInfo.shopName || entry?.shopName || '',
        source: sources.join('|'),
        sources,
        whyUnresolved: [],
        sessionPartitionKey: pageInfo.sessionPartitionKey,
        accountId: pageInfo.accountId,
      };
    }
    if (pageInfo.shopId && !isKnownShopId(pageInfo.shopId)) {
      whyUnresolved.push('shopId_not_in_knownShops');
    } else {
      whyUnresolved.push('missing_shopId');
    }

    if (pageInfo.shopName) {
      const byName = shopNameToShop.get(normalizeShopName(pageInfo.shopName));
      if (byName) {
        sources.push('pageInfo.shopName', 'knownShops');
        return { ...byName, source: sources.join('|'), sources, whyUnresolved: [], sessionPartitionKey: pageInfo.sessionPartitionKey, accountId: pageInfo.accountId };
      }
      const known = resolver.matchByName(pageInfo.shopName);
      if (known) {
        sources.push('knownShops');
        return {
          shopId: String(known.shopId),
          shopName: known.shopName,
          source: sources.join('|'),
          sources,
          whyUnresolved: [],
          sessionPartitionKey: pageInfo.sessionPartitionKey,
          accountId: pageInfo.accountId,
        };
      }
    }

    if (pageInfo.sessionPartitionKey) {
      const byPartition = partitionKeyToShop.get(String(pageInfo.sessionPartitionKey));
      if (byPartition) {
        sources.push('partitionKey');
        return { ...byPartition, source: sources.join('|'), sources, whyUnresolved: [], sessionPartitionKey: pageInfo.sessionPartitionKey, accountId: pageInfo.accountId };
      }
      whyUnresolved.push('partition_not_mapped');
    } else {
      whyUnresolved.push('missing_sessionPartitionKey');
    }

    if (pageInfo.accountId) {
      const byAccount = accountIdToShop.get(String(pageInfo.accountId));
      if (byAccount) {
        sources.push('accountId');
        return { ...byAccount, source: sources.join('|'), sources, whyUnresolved: [], sessionPartitionKey: pageInfo.sessionPartitionKey, accountId: pageInfo.accountId };
      }
    }

    const bridgePartition = bridgeIdToPartitionKey.get(bridge.bridgeId);
    if (bridgePartition) {
      const byBridgePartition = partitionKeyToShop.get(String(bridgePartition));
      if (byBridgePartition) {
        sources.push('bridgeMemoryCache');
        return {
          ...byBridgePartition,
          source: sources.join('|'),
          sources,
          whyUnresolved: [],
          sessionPartitionKey: bridgePartition,
          accountId: extractPersistAccountId(bridgePartition),
        };
      }
      if (!whyUnresolved.includes('partition_not_mapped')) whyUnresolved.push('partition_not_mapped');
    }

    const bridgeShop = bridgeIdToShop.get(bridge.bridgeId);
    if (bridgeShop && isKnownShopId(bridgeShop.shopId)) {
      sources.push('memory_cache');
      return { ...bridgeShop, source: sources.join('|'), sources, whyUnresolved: [], sessionPartitionKey: pageInfo.sessionPartitionKey, accountId: pageInfo.accountId };
    }

    if (bridgeHint?.shopId && isKnownShopId(bridgeHint.shopId)) {
      sources.push('memory_cache');
      return {
        shopId: String(bridgeHint.shopId),
        shopName: bridgeHint.shopName || shopIdToShop.get(String(bridgeHint.shopId))?.shopName || '',
        source: sources.join('|'),
        sources,
        whyUnresolved: [],
        sessionPartitionKey: pickFirst(bridgeHint.sessionPartitionKey, pageInfo.sessionPartitionKey),
        accountId: pageInfo.accountId,
      };
    }

    return {
      shopId: '',
      shopName: pageInfo.shopName || '',
      source: '',
      sources,
      whyUnresolved: [...new Set(whyUnresolved)],
      sessionPartitionKey: pageInfo.sessionPartitionKey,
      accountId: pageInfo.accountId,
    };
  }

  function buildUnknownImBridge(bridge, resolved, accountMapRef) {
    const hrefs = bridge.hrefs || [];
    return {
      bridgeId: bridge.bridgeId,
      href: hrefs[0] || '',
      hrefs: hrefs.slice(0, 5),
      title: (bridge.titles || [])[0] || '',
      titles: (bridge.titles || []).slice(0, 3),
      hasHeartbeat: Boolean(bridge.lastHeartbeatAt || bridge.heartbeatCount > 0),
      observerReady: Boolean(bridge.observerReady),
      sessionPartitionKey: pickFirst(
        bridge.sessionPartitionKey,
        accountMapRef.bridgeIdToPartitionKey.get(bridge.bridgeId)
      ),
      accountId: pickFirst(bridge.accountId, bridge.persistAccountId),
      lastMemoryCacheApi: accountMapRef.bridgeIdToLastApi.get(bridge.bridgeId) || '',
      whyUnresolved: resolved.whyUnresolved?.length
        ? resolved.whyUnresolved
        : ['missing_shopId'],
    };
  }

  return {
    accountIdToShop,
    partitionKeyToShop,
    shopNameToShop,
    shopIdToShop,
    bridgeIdToPartitionKey,
    bridgeIdToShop,
    bridgeIdToLastApi,
    isKnownShopId,
    ingestStdoutAccount,
    ingestStdoutShop,
    ingestIdentityHint,
    ingestMemoryCacheHint,
    resolveShopForBridge,
    buildUnknownImBridge,
    getResolver: () => resolver,
  };
}

function extractPartitionFromCacheKey(cacheKey) {
  const key = String(cacheKey || '');
  const match = key.match(/persist:\d{10,20}/);
  return match ? match[0] : '';
}

module.exports = {
  createAccountShopMap,
  extractPersistAccountId,
  extractPartitionFromCacheKey,
  normalizeShopName,
  NOISE_SHOP_NAMES,
};
