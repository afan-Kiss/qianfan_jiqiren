const {
  createShopResolver,
  isImWorkspaceHref,
  isImBridgeActive,
} = require('./doudian-shop-resolver');
const { createAccountShopMap } = require('./doudian-account-shop-map');
const { pickFirst } = require('./doudian-shop-utils');

function mergeSources(existing, source) {
  const list = Array.isArray(existing) ? [...existing] : [];
  if (source && !list.includes(source)) list.push(source);
  return list;
}

function upsertLoggedIn(map, resolved, source) {
  const id = resolved.shopId;
  if (!id) return;
  const src = source || resolved.sources?.[0] || resolved.source || 'unknown';
  let entry = map.get(id);
  if (!entry) {
    entry = {
      shopId: id,
      shopName: resolved.shopName || '',
      source: src,
      sources: mergeSources([], src),
    };
    map.set(id, entry);
    return;
  }
  if (!entry.shopName && resolved.shopName) entry.shopName = resolved.shopName;
  entry.sources = mergeSources(entry.sources, src);
  entry.source = entry.sources.join('|');
}

function isNoiseShopName(name) {
  const { NOISE_SHOP_NAMES } = require('./doudian-shop-resolver');
  return !name || NOISE_SHOP_NAMES.test(String(name).trim());
}

function buildKnownShopIdSet(knownShops = []) {
  return new Set(knownShops.map((ks) => String(ks.shopId)).filter(Boolean));
}

function buildStdoutLoggedInIdSet(stdoutSignal = {}) {
  const ids = new Set();
  for (const shop of stdoutSignal.loggedInShops || []) {
    if (shop.shopId) ids.add(String(shop.shopId));
  }
  return ids;
}

function isEligibleLoggedInShopId(shopId, knownShopIds, stdoutLoggedInIds, stdoutShopIds) {
  const id = String(shopId || '');
  if (!id) return false;
  if (stdoutLoggedInIds.size > 0) return stdoutLoggedInIds.has(id);
  if (stdoutShopIds.size > 0) return stdoutShopIds.has(id) && knownShopIds.has(id);
  return knownShopIds.has(id);
}

function seedMissingKnownLoggedInShops(loggedInShopMap, stdoutSignal, knownShops, canAddLoggedIn) {
  const stdoutIds = new Set((stdoutSignal.shopIds || []).map((id) => String(id)));
  const accountNum = Math.max(
    Number(stdoutSignal.accountNum || 0),
    Number(stdoutSignal.shopAccountNum || 0)
  );
  const dualAccount =
    accountNum >= 2 ||
    (stdoutSignal.loggedInShops || []).length >= 2 ||
    [...stdoutIds].filter((id) => knownShops.some((ks) => String(ks.shopId) === id)).length >= 2;

  for (const ks of knownShops) {
    const id = String(ks.shopId);
    if (loggedInShopMap.has(id)) continue;
    const inStdout =
      stdoutIds.has(id) ||
      (stdoutSignal.loggedInShops || []).some((s) => String(s.shopId) === id);
    if (inStdout && canAddLoggedIn(id)) {
      upsertLoggedIn(
        loggedInShopMap,
        { shopId: id, shopName: ks.shopName, sources: ['stdout_accounts'] },
        'stdout_accounts'
      );
    }
  }

  if (dualAccount && loggedInShopMap.size >= 1 && knownShops.length >= 2) {
    for (const ks of knownShops) {
      const id = String(ks.shopId);
      if (loggedInShopMap.has(id)) continue;
      upsertLoggedIn(
        loggedInShopMap,
        { shopId: id, shopName: ks.shopName, sources: ['stdout_accounts'] },
        'stdout_accounts'
      );
    }
  }
}

function enrichFromKnownShops(loggedInShopMap, knownShops) {
  for (const entry of loggedInShopMap.values()) {
    const ks = knownShops.find((k) => String(k.shopId) === String(entry.shopId));
    if (!ks) continue;
    if (!entry.shopName || isNoiseShopName(entry.shopName)) entry.shopName = ks.shopName;
    entry.sources = mergeSources(entry.sources, 'knownShops');
    entry.source = entry.sources.join('|');
  }
}

function buildShopStatsSnapshot(options = {}) {
  const {
    tracker,
    stdoutSignal = {},
    knownShops = [],
    shopIdentityHints = [],
    memoryCacheHints = [],
    heartbeatTimeoutMs = 90000,
    now = Date.now(),
  } = options;

  const accountMap = createAccountShopMap(knownShops);
  const knownShopIds = buildKnownShopIdSet(knownShops);
  const stdoutLoggedInIds = buildStdoutLoggedInIdSet(stdoutSignal);
  const stdoutShopIds = new Set((stdoutSignal.shopIds || []).map((id) => String(id)));
  const loggedInShopMap = new Map();
  const activeImShopMap = new Map();
  const unknownBridges = [];
  const unknownImBridges = [];
  const warnings = [];

  const canAddLoggedIn = (shopId) =>
    isEligibleLoggedInShopId(shopId, knownShopIds, stdoutLoggedInIds, stdoutShopIds);

  for (const account of stdoutSignal.stdoutAccounts || []) {
    accountMap.ingestStdoutAccount(account);
  }
  for (const shop of stdoutSignal.loggedInShops || []) {
    accountMap.ingestStdoutShop(shop);
  }
  for (const hint of shopIdentityHints) {
    if (hint.shopId && !accountMap.isKnownShopId(hint.shopId)) continue;
    accountMap.ingestIdentityHint(hint);
  }
  for (const hint of memoryCacheHints) {
    accountMap.ingestMemoryCacheHint(hint);
  }

  for (const shop of stdoutSignal.loggedInShops || []) {
    if (shop.shopId && canAddLoggedIn(shop.shopId)) {
      upsertLoggedIn(loggedInShopMap, { shopId: String(shop.shopId), shopName: shop.shopName, sources: ['stdout_accounts'] }, 'stdout_accounts');
    }
  }

  if (loggedInShopMap.size === 0) {
    for (const id of stdoutShopIds) {
      if (!knownShopIds.has(id)) continue;
      upsertLoggedIn(loggedInShopMap, { shopId: id, shopName: accountMap.shopIdToShop.get(id)?.shopName || '', sources: ['stdout_accounts'] }, 'stdout_accounts');
    }
  }

  for (const hint of shopIdentityHints) {
    if (!canAddLoggedIn(hint.shopId)) continue;
    upsertLoggedIn(
      loggedInShopMap,
      { shopId: String(hint.shopId), shopName: hint.shopName, sources: [hint.source || 'memory_cache'] },
      hint.source || 'memory_cache'
    );
  }

  seedMissingKnownLoggedInShops(loggedInShopMap, stdoutSignal, knownShops, canAddLoggedIn);

  const identityHintByBridge = new Map();
  for (const hint of shopIdentityHints) {
    if (hint.bridgeId) identityHintByBridge.set(hint.bridgeId, hint);
  }
  const memoryHintByBridge = new Map();
  for (const hint of memoryCacheHints) {
    if (hint.bridgeId) memoryHintByBridge.set(hint.bridgeId, hint);
  }

  const bridges = tracker ? tracker.getAllBridges() : [];
  let imBridgeSeen = 0;

  for (const bridge of bridges) {
    const hrefs = bridge.hrefs || [];
    const isIm = bridge.isImWorkspace || hrefs.some((h) => isImWorkspaceHref(h));
    if (isIm) imBridgeSeen += 1;

    const bridgeHint = identityHintByBridge.get(bridge.bridgeId) || memoryHintByBridge.get(bridge.bridgeId);
    const resolved = accountMap.resolveShopForBridge(bridge, bridgeHint);
    const knownShopId =
      resolved.shopId && accountMap.isKnownShopId(resolved.shopId) ? String(resolved.shopId) : '';
    const imActive = isImBridgeActive(bridge, heartbeatTimeoutMs, now);

    if (isIm) {
      if (!knownShopId) {
        unknownImBridges.push(accountMap.buildUnknownImBridge(bridge, resolved, accountMap));
        continue;
      }
      if (imActive && loggedInShopMap.has(knownShopId)) {
        let active = activeImShopMap.get(knownShopId);
        if (!active) {
          active = {
            shopId: knownShopId,
            shopName: resolved.shopName || loggedInShopMap.get(knownShopId)?.shopName || '',
            bridgeIds: [],
            observerReady: false,
            source: resolved.source || 'im_bridge',
            sources: mergeSources([], ...(resolved.sources || [])),
          };
          activeImShopMap.set(knownShopId, active);
        }
        if (!active.bridgeIds.includes(bridge.bridgeId)) active.bridgeIds.push(bridge.bridgeId);
        active.observerReady = active.observerReady || bridge.observerReady;
        active.sources = mergeSources(active.sources, ...(resolved.sources || []));
        active.source = active.sources.join('|') || active.source;
        if (!active.shopName && resolved.shopName) active.shopName = resolved.shopName;
      }
      continue;
    }

    if (!knownShopId) {
      unknownBridges.push({
        bridgeId: bridge.bridgeId,
        hrefs: hrefs.slice(0, 5),
        titles: (bridge.titles || []).slice(0, 3),
        isImWorkspace: false,
        shopNameHint: pickFirst(bridge.shopName, bridge.activeShopNameFromDom),
      });
    }
  }

  enrichFromKnownShops(loggedInShopMap, knownShops);

  for (const id of [...loggedInShopMap.keys()]) {
    if (!knownShopIds.has(String(id))) loggedInShopMap.delete(id);
  }

  const loggedInShops = [...loggedInShopMap.values()];
  const activeImShops = [...activeImShopMap.values()]
    .filter((item) => loggedInShopMap.has(String(item.shopId)))
    .map((item) => ({
      shopId: item.shopId,
      shopName: item.shopName,
      source: item.source,
      activeImBridgeIds: item.bridgeIds,
      bridgeIds: item.bridgeIds,
      observerReady: item.observerReady,
    }));

  const activeIds = new Set(activeImShops.map((s) => s.shopId));
  const inactiveShops = loggedInShops
    .filter((s) => !activeIds.has(s.shopId))
    .map((s) => ({
      shopId: s.shopId,
      shopName: s.shopName,
      source: s.source,
    }));

  if (unknownImBridges.length > 0) {
    warnings.push('存在 IM bridge 未识别店铺归属，已排除出 activeImShops 统计');
  }
  if (imBridgeSeen > 0 && activeImShops.length === 0 && unknownImBridges.length === 0) {
    warnings.push('检测到 IM bridge 但未产出 activeImShops 或 unknownImBridges 诊断，请检查归属逻辑');
  }

  return {
    loggedInShopCount: loggedInShops.length,
    activeImShopCount: activeImShops.length,
    inactiveShopCount: inactiveShops.length,
    loggedInShops,
    activeImShops,
    inactiveShops,
    unknownBridges,
    unknownImBridges,
    imBridgeSeen,
    warnings,
  };
}

const SHOP_STATS_WARNING_MARKERS = [
  '存在 IM bridge 未识别店铺归属',
  '检测到 IM bridge 但未产出',
  '已登录',
  '检测到第二店铺',
];

function applyShopStatsToTarget(target, snapshot) {
  target.loggedInShopCount = snapshot.loggedInShopCount;
  target.activeImShopCount = snapshot.activeImShopCount;
  target.inactiveShopCount = snapshot.inactiveShopCount;
  target.loggedInShops = snapshot.loggedInShops;
  target.activeImShops = snapshot.activeImShops;
  target.inactiveShops = snapshot.inactiveShops;
  target.unknownBridges = snapshot.unknownBridges;
  target.unknownImBridges = snapshot.unknownImBridges;
  target.imBridgeSeen = snapshot.imBridgeSeen || 0;
  if (!target.warnings) target.warnings = [];
  target.warnings = target.warnings.filter(
    (warning) => !SHOP_STATS_WARNING_MARKERS.some((marker) => warning.includes(marker))
  );
  for (const warning of snapshot.warnings || []) {
    if (!target.warnings.includes(warning)) target.warnings.push(warning);
  }
}

module.exports = {
  buildShopStatsSnapshot,
  applyShopStatsToTarget,
};
