#!/usr/bin/env node
/**
 * IM bridge -> shopId 归属专项测试
 * npm run doudian:test-im-shop-resolve
 */
const { ShopBridgeTracker } = require('./lib/shop-bridge-tracker');
const { getDoudianConfig } = require('../src/shared/config');
const { buildShopStatsSnapshot } = require('../src/platforms/doudian/doudian-shop-stats-aggregator');
const { parseStdoutBusinessSignals } = require('../src/platforms/doudian/doudian-stdout-business-parser');

const IM_HREF = 'https://im.jinritemai.com/pc_seller_desk_v2/main/workspace';
const ACCOUNT_XY = '7617801086510931507';
const ACCOUNT_FS = '7631127325130931507';

function makeEnvelope(type, bridgeId, payload) {
  return { type, bridgeId, timestamp: Date.now(), payload };
}

function feedBridge(tracker, bridgeId, payload, types = ['bridge.heartbeat']) {
  for (const type of types) {
    tracker.recordEvent(makeEnvelope(type, bridgeId, payload));
  }
}

function main() {
  const cfg = getDoudianConfig();
  const knownShops = cfg.knownShops || [];
  const tracker = new ShopBridgeTracker({ knownShops });

  const stdoutLine =
    'init window with accounts token:"***" ' +
    `"id":"${ACCOUNT_XY}","sessionPartitionKey":"persist:${ACCOUNT_XY}","meta":{"shopId":263636465,"shopName":"XY祥钰珠宝"} ` +
    `"id":"${ACCOUNT_FS}","sessionPartitionKey":"persist:${ACCOUNT_FS}","meta":{"shopId":276595872,"shopName":"梵诗娅珠宝"} ` +
    'accountNum=2';
  const stdoutSignal = parseStdoutBusinessSignals([stdoutLine]);

  feedBridge(
    tracker,
    'bridge_im_partition',
    { href: IM_HREF, sessionPartitionKey: `persist:${ACCOUNT_XY}`, isImWorkspace: true },
    ['bridge.heartbeat', 'doudian.message.observer_ready']
  );

  feedBridge(
    tracker,
    'bridge_im_memory',
    { href: IM_HREF, isImWorkspace: true },
    ['bridge.heartbeat', 'doudian.message.observer_ready']
  );

  feedBridge(
    tracker,
    'bridge_im_memory_dup',
    { href: IM_HREF, isImWorkspace: true },
    ['bridge.heartbeat']
  );

  feedBridge(
    tracker,
    'bridge_im_garbled',
    { href: IM_HREF, shopName: 'XY绁ラ挵鐝犲疂', isImWorkspace: true },
    ['bridge.heartbeat', 'doudian.message.observer_ready']
  );

  feedBridge(
    tracker,
    'bridge_im_unknown',
    { href: IM_HREF, isImWorkspace: true },
    ['bridge.heartbeat']
  );

  const memoryCacheHints = [
    {
      bridgeId: 'bridge_im_memory',
      cacheKey: `persist:${ACCOUNT_XY}`,
      apiName: 'currentuser',
      sessionPartitionKey: `persist:${ACCOUNT_XY}`,
      source: 'memory_cache',
    },
    {
      bridgeId: 'bridge_im_memory_dup',
      cacheKey: `persist:${ACCOUNT_XY}`,
      apiName: 'get_current_conversation_list',
      sessionPartitionKey: `persist:${ACCOUNT_XY}`,
      source: 'memory_cache',
    },
    {
      bridgeId: 'bridge_im_garbled',
      cacheKey: `persist:${ACCOUNT_XY}`,
      apiName: 'currentuser',
      shopId: '263636465',
      source: 'memory_cache',
    },
  ];

  const snapshot = buildShopStatsSnapshot({
    tracker,
    stdoutSignal,
    knownShops,
    shopIdentityHints: [],
    memoryCacheHints,
  });

  const partitionResolveOk = snapshot.activeImShops.some((s) => s.shopId === '263636465');
  const bridgeMemoryCacheResolveOk = snapshot.activeImShops.some((s) =>
    (s.activeImBridgeIds || s.bridgeIds || []).includes('bridge_im_memory')
  );
  const unknownImBridgeClassified = snapshot.unknownImBridges.some(
    (b) => b.bridgeId === 'bridge_im_unknown'
  );
  const dedupeOk =
    snapshot.activeImShopCount === 1 &&
    (snapshot.activeImShops[0]?.activeImBridgeIds?.length || 0) >= 2;
  const balanceOk =
    snapshot.activeImShopCount + snapshot.inactiveShopCount === snapshot.loggedInShopCount;

  const success =
    snapshot.loggedInShopCount === 2 &&
    snapshot.activeImShopCount === 1 &&
    snapshot.inactiveShopCount === 1 &&
    partitionResolveOk &&
    bridgeMemoryCacheResolveOk &&
    unknownImBridgeClassified &&
    dedupeOk &&
    balanceOk;

  const output = {
    success,
    loggedInShopCount: snapshot.loggedInShopCount,
    activeImShopCount: snapshot.activeImShopCount,
    inactiveShopCount: snapshot.inactiveShopCount,
    unknownImBridgeClassified,
    partitionResolveOk,
    bridgeMemoryCacheResolveOk,
    dedupeOk,
    balanceOk,
    activeImShops: snapshot.activeImShops,
    inactiveShops: snapshot.inactiveShops,
    unknownImBridges: snapshot.unknownImBridges,
    warnings: snapshot.warnings,
  };

  console.log(JSON.stringify(output, null, 2));
  process.exit(success ? 0 : 1);
}

main();
