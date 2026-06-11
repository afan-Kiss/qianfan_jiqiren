#!/usr/bin/env node
/**
 * 多店铺统计与归属专项测试
 * npm run doudian:test-shop-tracker
 */
const { ShopBridgeTracker } = require('./lib/shop-bridge-tracker');
const { getDoudianConfig } = require('../src/shared/config');
const { buildShopStatsSnapshot } = require('../src/platforms/doudian/doudian-shop-stats-aggregator');
const { parseStdoutBusinessSignals } = require('../src/platforms/doudian/doudian-stdout-business-parser');

const IM_HREF = 'https://im.jinritemai.com/pc_seller_desk_v2/main/workspace';
const HOME_HREF = 'https://fxg.jinritemai.com/ffa/mshop/homepage';

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

  const stdoutSignal = parseStdoutBusinessSignals([
    'init window with accounts shopId=263636465 shopName=XY祥钰珠宝 sessionPartitionKey=partition_xy',
    'init window with accounts shopId=276595872 shopName=梵诗娅珠宝 sessionPartitionKey=partition_fs',
  ]);

  feedBridge(tracker, 'bridge_home_xy', { href: HOME_HREF, shopId: '263636465', shopName: 'XY祥钰珠宝' });
  feedBridge(tracker, 'bridge_home_fs', { href: HOME_HREF, shopId: '276595872', shopName: '梵诗娅珠宝' });
  feedBridge(
    tracker,
    'bridge_im_xy',
    { href: IM_HREF, shopId: '263636465', shopName: 'XY祥钰珠宝', isImWorkspace: true },
    ['bridge.heartbeat', 'doudian.message.observer_ready']
  );
  feedBridge(
    tracker,
    'bridge_im_xy_dup',
    { href: IM_HREF, shopId: '263636465', shopName: 'XY绁ラ挵鐝犲疂', isImWorkspace: true },
    ['bridge.heartbeat']
  );
  feedBridge(tracker, 'bridge_empty', {
    href: 'https://im.jinritemai.com/pc_seller_desk_v2/main/empty',
    title: '实时',
  });
  feedBridge(tracker, 'bridge_unknown', { href: 'https://example.com/random', title: 'unknown page' });
  feedBridge(
    tracker,
    'bridge_im_unknown',
    { href: IM_HREF, title: '飞鸽客服系统', isImWorkspace: true },
    ['bridge.heartbeat', 'doudian.message.observer_ready']
  );

  const shopIdentityHints = [
    { shopId: '263636465', shopName: 'XY祥钰珠宝', source: 'memory_cache' },
  ];

  const snapshot = buildShopStatsSnapshot({
    tracker,
    stdoutSignal,
    knownShops,
    shopIdentityHints,
  });

  const unknownBridgeExcluded =
    snapshot.unknownBridges.length >= 2 && snapshot.loggedInShopCount === 2;
  const dedupeByShopIdOk =
    snapshot.activeImShopCount === 1 &&
    (snapshot.activeImShops[0]?.bridgeIds?.length || 0) >= 2;
  const inactiveOk =
    snapshot.inactiveShopCount === 1 &&
    snapshot.inactiveShops.some((s) => s.shopId === '276595872');

  const success =
    snapshot.loggedInShopCount === 2 &&
    snapshot.activeImShopCount === 1 &&
    snapshot.inactiveShopCount === 1 &&
    unknownBridgeExcluded &&
    dedupeByShopIdOk &&
    inactiveOk;

  const output = {
    success,
    loggedInShopCount: snapshot.loggedInShopCount,
    activeImShopCount: snapshot.activeImShopCount,
    inactiveShopCount: snapshot.inactiveShopCount,
    unknownBridgeExcluded,
    dedupeByShopIdOk,
    loggedInShops: snapshot.loggedInShops,
    activeImShops: snapshot.activeImShops,
    inactiveShops: snapshot.inactiveShops,
    unknownBridgesCount: snapshot.unknownBridges.length,
    unknownImBridgesCount: snapshot.unknownImBridges.length,
    warnings: snapshot.warnings,
  };

  console.log(JSON.stringify(output, null, 2));
  process.exit(success ? 0 : 1);
}

main();
