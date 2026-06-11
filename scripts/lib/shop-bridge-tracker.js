const {
  WORKSPACE_URL_PATTERN,
  HOMEPAGE_URL_PATTERN,
} = require('../../src/platforms/doudian/doudian-asar-patch-constants');
const {
  extractShopFromPayload,
  mergePageInfo,
  scoreImBridge,
  maskAccountId,
  pickFirst,
} = require('../../src/platforms/doudian/doudian-shop-utils');
const { createShopResolver } = require('../../src/platforms/doudian/doudian-shop-resolver');
const { IM_WATCH_TYPES, classifyHref, summarizeEvent } = require('./bridge-tracker');

const LISTEN_WATCH_TYPES = new Set([
  ...IM_WATCH_TYPES,
  'doudian.shop.detected',
  'doudian.message.observer_ready',
  'doudian.message.dom_snapshot',
  'doudian.message.dom_added',
  'doudian.message.network_candidate',
  'doudian.message.dom_candidate',
  'doudian.network.buffer_replay',
  'doudian.im.dom_diagnostic',
  'doudian.im.empty_state',
  'doudian.conversation.empty',
  'doudian.worker.network_candidate',
  'doudian.memory_cache.candidate',
  'doudian.shop.identity_resolved',
  'doudian.conversation.list',
  'doudian.message.real_candidate',
  'doudian.chat.history_snapshot',
  'doudian.chat.dom_inspection',
  'doudian.chat.history_candidate',
  'doudian.chat.conversation_hints',
  'doudian.reply.editor_inspection',
  'doudian.reply.draft_filled',
  'doudian.message.send_result',
  'doudian.conversation.list_captured',
  'doudian.conversation.sources_inspection',
  'doudian.ui.noise',
]);

function summarizeListenEvent(envelope, resolver) {
  const base = summarizeEvent(envelope);
  const shop = extractShopFromPayload(envelope.payload || {});
  const resolved = resolver
    ? resolver.resolve({
        shopId: shop.shopId,
        shopName: shop.shopName,
        sessionPartitionKey: shop.sessionPartitionKey,
        bridgeId: base.bridgeId,
        source: envelope.payload?.shopIdentitySource || envelope.payload?.source,
      })
    : { shopKey: shop.shopId ? `shop:${shop.shopId}` : `unknown:${base.bridgeId}` };
  return {
    ...base,
    ...shop,
    accountIdMasked: maskAccountId(shop.accountId),
    sessionPartitionKey: shop.sessionPartitionKey,
    shopKey: resolved.shopKey,
    shopId: resolved.shopId || shop.shopId,
    shopName: resolved.shopName || shop.shopName,
  };
}

class ShopBridgeTracker {
  constructor(options = {}) {
    this.knownShops = options.knownShops || [];
    this.resolver = createShopResolver(this.knownShops);
    this.bridges = new Map();
    this.shops = new Map();
    this.events = [];
    this.unknownBridges = [];
  }

  upsertBridge(envelope) {
    const summary = summarizeListenEvent(envelope, this.resolver);
    this.events.push(summary);
    const bridgeId = summary.bridgeId || 'unknown';
    const now = Date.now();
    let entry = this.bridges.get(bridgeId);
    if (!entry) {
      entry = {
        bridgeId,
        firstSeenAt: now,
        lastSeenAt: now,
        lastHeartbeatAt: 0,
        eventTypes: [],
        hrefs: [],
        titles: [],
        heartbeatCount: 0,
        isHomepage: false,
        isImWorkspace: false,
        isUnknown: false,
        isRustWorker: false,
        isEmptyBridge: false,
        shopId: '',
        shopName: '',
        accountId: '',
        sessionPartitionKey: '',
        activeShopNameFromDom: '',
        activeShopIdFromDom: '',
        visibilityState: '',
        hasFocus: false,
        chatListExists: false,
        inputExists: false,
        bodyTextLength: 0,
        persistAccountId: '',
        shopKey: '',
        observerReady: false,
        domSnapshotCount: 0,
        domAddedCount: 0,
        networkCandidateCount: 0,
      };
      this.bridges.set(bridgeId, entry);
    }

    entry.lastSeenAt = now;
    if (!entry.eventTypes.includes(summary.type)) entry.eventTypes.push(summary.type);
    if (summary.href && !entry.hrefs.includes(summary.href)) entry.hrefs.push(summary.href);
    if (summary.title && !entry.titles.includes(summary.title)) entry.titles.push(summary.title);

    const page = mergePageInfo(envelope.payload || {});
    entry.shopId = page.shopId || entry.shopId;
    entry.shopName = page.shopName || entry.shopName;
    entry.shopIdentitySource = pickFirst(
      envelope.payload?.shopIdentitySource,
      envelope.payload?.shopInfo?.shopIdentitySource,
      entry.shopIdentitySource
    );
    entry.accountId = page.accountId || entry.accountId;
    entry.sessionPartitionKey = page.sessionPartitionKey || entry.sessionPartitionKey;
    entry.persistAccountId = pickFirst(page.persistAccountId, entry.persistAccountId);
    entry.activeShopNameFromDom = page.activeShopNameFromDom || entry.activeShopNameFromDom;
    entry.activeShopIdFromDom = page.activeShopIdFromDom || entry.activeShopIdFromDom;
    entry.visibilityState = page.visibilityState || entry.visibilityState;
    entry.hasFocus = page.hasFocus || entry.hasFocus;
    entry.chatListExists = page.chatListExists || entry.chatListExists;
    entry.inputExists = page.inputExists || entry.inputExists;
    entry.bodyTextLength = Math.max(entry.bodyTextLength, page.bodyTextLength || 0);
    entry.isImWorkspace = entry.isImWorkspace || summary.isImWorkspace || page.isImWorkspace;
    entry.isHomepage = entry.isHomepage || summary.isHomepage;
    entry.isUnknown = entry.isUnknown || summary.isUnknown;
    entry.isRustWorker = entry.isRustWorker || summary.isRustWorker;
    entry.isEmptyBridge = entry.isEmptyBridge || summary.isEmptyBridge;

    const resolved = this.resolver.resolve({
      shopId: pickFirst(entry.shopId, entry.activeShopIdFromDom),
      shopName: pickFirst(entry.shopName, entry.activeShopNameFromDom),
      sessionPartitionKey: entry.sessionPartitionKey,
      bridgeId: entry.bridgeId,
      source: pickFirst(
        envelope.payload?.shopIdentitySource,
        envelope.payload?.shopInfo?.shopIdentitySource,
        envelope.payload?.source
      ),
    });
    if (resolved.shopId) {
      entry.shopId = resolved.shopId;
      entry.shopName = pickFirst(entry.shopName, resolved.shopName);
      entry.shopKey = resolved.shopKey;
      if (entry.sessionPartitionKey) {
        this.resolver.registerPartitionMapping(entry.sessionPartitionKey, resolved.shopId);
      }
    } else {
      entry.shopKey = resolved.shopKey;
    }

    if (summary.type === 'bridge.heartbeat') {
      entry.heartbeatCount += 1;
      entry.lastHeartbeatAt = now;
    }
    if (summary.type === 'doudian.message.observer_ready') entry.observerReady = true;
    if (summary.type === 'doudian.message.dom_snapshot') entry.domSnapshotCount += 1;
    if (summary.type === 'doudian.message.dom_added') entry.domAddedCount += 1;
    if (summary.type === 'doudian.message.network_candidate') entry.networkCandidateCount += 1;

    this.syncShop(entry);
    return summary;
  }

  recordEvent(envelope) {
    if (!envelope?.type) return null;
    if (!LISTEN_WATCH_TYPES.has(envelope.type)) return null;
    return this.upsertBridge(envelope);
  }

  syncShop(bridge) {
    if (!bridge.shopId) {
      if (!this.unknownBridges.includes(bridge.bridgeId)) {
        this.unknownBridges.push(bridge.bridgeId);
      }
      return;
    }

    const shopKey = `shop:${bridge.shopId}`;
    let shop = this.shops.get(shopKey);
    const now = Date.now();
    if (!shop) {
      shop = {
        shopKey,
        shopId: bridge.shopId || '',
        shopName: bridge.shopName || bridge.activeShopNameFromDom || '',
        accountId: bridge.accountId || '',
        accountIdMasked: maskAccountId(bridge.accountId),
        sessionPartitionKey: bridge.sessionPartitionKey || '',
        bridges: [],
        activeImBridgeId: '',
        homepageBridgeIds: [],
        imBridgeIds: [],
        lastSeenAt: now,
        observerReady: false,
        messageCount: 0,
        insertedMessageCount: 0,
        domSnapshotCount: 0,
        domAddedCount: 0,
        networkCandidateCount: 0,
        normalizedMessageCount: 0,
        dedupedMessageCount: 0,
        sampleMessages: [],
      };
      this.shops.set(shopKey, shop);
    }

    shop.shopId = shop.shopId || bridge.shopId;
    shop.shopName = shop.shopName || bridge.shopName || bridge.activeShopNameFromDom;
    shop.accountId = shop.accountId || bridge.accountId;
    shop.accountIdMasked = maskAccountId(shop.accountId);
    shop.sessionPartitionKey = shop.sessionPartitionKey || bridge.sessionPartitionKey;
    shop.lastSeenAt = now;
    if (!shop.bridges.includes(bridge.bridgeId)) shop.bridges.push(bridge.bridgeId);
    if (bridge.isHomepage && !shop.homepageBridgeIds.includes(bridge.bridgeId)) {
      shop.homepageBridgeIds.push(bridge.bridgeId);
    }
    if (bridge.isImWorkspace && !shop.imBridgeIds.includes(bridge.bridgeId)) {
      shop.imBridgeIds.push(bridge.bridgeId);
    }
    shop.observerReady = shop.observerReady || bridge.observerReady;
    shop.domSnapshotCount += 0;
    shop.domAddedCount += 0;
    shop.networkCandidateCount += 0;
  }

  refreshShopStats() {
    for (const shop of this.shops.values()) {
      shop.domSnapshotCount = 0;
      shop.domAddedCount = 0;
      shop.networkCandidateCount = 0;
      for (const bridgeId of shop.bridges) {
        const b = this.bridges.get(bridgeId);
        if (!b) continue;
        shop.domSnapshotCount += b.domSnapshotCount;
        shop.domAddedCount += b.domAddedCount;
        shop.networkCandidateCount += b.networkCandidateCount;
        shop.observerReady = shop.observerReady || b.observerReady;
      }
      shop.activeImBridgeId = this.selectActiveImBridgeForShop(shop.shopKey);
    }
  }

  selectActiveImBridgeForShop(shopKey) {
    const shop = this.shops.get(shopKey);
    if (!shop) return '';
    const candidates = shop.imBridgeIds
      .map((id) => this.bridges.get(id))
      .filter(Boolean)
      .map((b) => ({
        bridgeId: b.bridgeId,
        score: scoreImBridge({
          isImWorkspace: b.isImWorkspace,
          shopId: b.shopId,
          shopName: b.shopName,
          visibilityState: b.visibilityState,
          hasFocus: b.hasFocus,
          chatListExists: b.chatListExists,
          inputExists: b.inputExists,
          bodyTextLength: b.bodyTextLength,
          lastHeartbeatAt: b.lastHeartbeatAt,
        }),
        lastHeartbeatAt: b.lastHeartbeatAt || 0,
      }))
      .sort((a, b) => b.score - a.score || b.lastHeartbeatAt - a.lastHeartbeatAt);
    return candidates[0]?.bridgeId || shop.imBridgeIds[0] || '';
  }

  getAllBridges() {
    return [...this.bridges.values()];
  }

  getAllShops() {
    this.refreshShopStats();
    return [...this.shops.values()];
  }

  getShopCount() {
    return this.getAllShops().filter((s) => s.shopId).length;
  }

  hasImBridge() {
    return this.getAllBridges().some((b) => b.isImWorkspace);
  }

  hasHomepageBridge() {
    return this.getAllBridges().some((b) => b.isHomepage);
  }

  getImBridgeIds() {
    return this.getAllBridges().filter((b) => b.isImWorkspace).map((b) => b.bridgeId);
  }

  getHomepageBridgeIds() {
    return this.getAllBridges()
      .filter((b) => b.isHomepage)
      .map((b) => b.bridgeId);
  }

  getEmptyBridgeIds() {
    return this.getAllBridges()
      .filter((b) => b.isEmptyBridge)
      .map((b) => b.bridgeId);
  }

  getRecentOpenCommandBridgeIds(maxAgeMs = 180000) {
    const now = Date.now();
    return this.getAllBridges()
      .filter(
        (b) =>
          (b.isHomepage || b.isEmptyBridge) &&
          now - (b.lastSeenAt || 0) < maxAgeMs
      )
      .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
      .map((b) => b.bridgeId);
  }

  getBridgeClassificationCounts() {
    const bridges = this.getAllBridges();
    return {
      homepageBridgeSeen: bridges.some((b) => b.isHomepage) ? 1 : 0,
      emptyBridgeSeen: bridges.some((b) => b.isEmptyBridge) ? 1 : 0,
      rustWorkerBridgeSeen: bridges.some((b) => b.isRustWorker) ? 1 : 0,
      imBridgeSeen: bridges.some((b) => b.isImWorkspace) ? 1 : 0,
    };
  }

  getActiveImBridgeIdsByShop() {
    this.refreshShopStats();
    const out = [];
    for (const shop of this.shops.values()) {
      if (shop.activeImBridgeId) out.push({ shopKey: shop.shopKey, bridgeId: shop.activeImBridgeId });
    }
    return out;
  }
}

module.exports = {
  LISTEN_WATCH_TYPES,
  ShopBridgeTracker,
  summarizeListenEvent,
  HOMEPAGE_URL_PATTERN,
  WORKSPACE_URL_PATTERN,
};
