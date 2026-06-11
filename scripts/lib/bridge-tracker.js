const {
  WORKSPACE_URL_PATTERN,
  HOMEPAGE_URL_PATTERN,
} = require('../../src/platforms/doudian/doudian-asar-patch-constants');

const IM_WATCH_TYPES = new Set([
  'bridge.hello',
  'bridge.ready',
  'bridge.heartbeat',
  'bridge.dom_ready',
  'bridge.window_load',
  'bridge.pong',
  'bridge.log',
  'bridge.error',
  'bridge.open_im_attempt',
]);

function extractHref(envelope) {
  const p = envelope.payload || {};
  return String(p.href || p.url || p.info?.href || '');
}

function extractTitle(envelope) {
  const p = envelope.payload || {};
  return String(p.title || p.info?.title || '');
}

function extractReadyState(envelope) {
  const p = envelope.payload || {};
  return String(p.readyState || p.info?.readyState || '');
}

function classifyBridgeKind(bridgeId, href, title) {
  const id = String(bridgeId || '');
  const h = String(href || '');
  const t = String(title || '');
  const cls = classifyHref(h);
  const isRustWorker = /^rust-worker-/i.test(id);
  const isEmpty = h.includes('/ffa/empty') || t === '抖店';
  return {
    ...cls,
    isRustWorker,
    isEmptyBridge: isEmpty && !cls.isHomepage && !cls.isImWorkspace,
  };
}

function summarizeEvent(envelope) {
  const href = extractHref(envelope);
  const cls = classifyBridgeKind(envelope.bridgeId, href, extractTitle(envelope));
  return {
    type: envelope.type,
    bridgeId: envelope.bridgeId || '',
    timestamp: envelope.timestamp || Date.now(),
    href,
    title: extractTitle(envelope),
    readyState: extractReadyState(envelope),
    pathname: envelope.payload?.pathname || envelope.payload?.info?.pathname || '',
    ...cls,
  };
}

class BridgeTracker {
  constructor() {
    /** @type {Map<string, object>} */
    this.bridges = new Map();
    this.events = [];
  }

  recordEvent(envelope) {
    if (!envelope?.type) return null;
    const summary = summarizeEvent(envelope);
    this.events.push(summary);

    const bridgeId = summary.bridgeId || 'unknown';
    let entry = this.bridges.get(bridgeId);
    const now = Date.now();

    if (!entry) {
      entry = {
        bridgeId,
        firstSeenAt: now,
        lastSeenAt: now,
        eventTypes: [],
        hrefs: [],
        titles: [],
        heartbeatCount: 0,
        imHeartbeatCount: 0,
        isHomepage: false,
        isImWorkspace: false,
        isUnknown: false,
        isRustWorker: false,
        isEmptyBridge: false,
        firstHomepageAt: null,
        firstImAt: null,
      };
      this.bridges.set(bridgeId, entry);
    }

    entry.lastSeenAt = now;
    if (!entry.eventTypes.includes(summary.type)) {
      entry.eventTypes.push(summary.type);
    }
    if (summary.href && !entry.hrefs.includes(summary.href)) {
      entry.hrefs.push(summary.href);
    }
    if (summary.title && !entry.titles.includes(summary.title)) {
      entry.titles.push(summary.title);
    }

    if (summary.isHomepage) {
      entry.isHomepage = true;
      if (!entry.firstHomepageAt) entry.firstHomepageAt = now;
    }
    if (summary.isImWorkspace) {
      entry.isImWorkspace = true;
      if (!entry.firstImAt) entry.firstImAt = now;
    }
    if (summary.isUnknown) entry.isUnknown = true;
    if (summary.isRustWorker) entry.isRustWorker = true;
    if (summary.isEmptyBridge) entry.isEmptyBridge = true;

    if (summary.type === 'bridge.heartbeat') {
      entry.heartbeatCount += 1;
      if (summary.isImWorkspace) entry.imHeartbeatCount += 1;
    }

    return summary;
  }

  getAllBridges() {
    return [...this.bridges.values()];
  }

  getBridgeCount() {
    return this.bridges.size;
  }

  hasHomepageBridge() {
    return this.getAllBridges().some((b) => b.isHomepage);
  }

  hasImBridge() {
    return this.getAllBridges().some((b) => b.isImWorkspace);
  }

  getFirstHomepageBridgeEvent() {
    for (const e of this.events) {
      if (e.isHomepage && IM_WATCH_TYPES.has(e.type)) return e;
    }
    return null;
  }

  getFirstImBridgeEvent() {
    for (const e of this.events) {
      if (e.isImWorkspace && IM_WATCH_TYPES.has(e.type)) return e;
    }
    return null;
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

  getImHeartbeatCount() {
    return this.getAllBridges().reduce((sum, b) => sum + (b.imHeartbeatCount || 0), 0);
  }

  countImRelatedHrefs() {
    let n = 0;
    for (const b of this.getAllBridges()) {
      for (const h of b.hrefs) {
        if (h.includes('im.jinritemai.com')) n += 1;
      }
    }
    return n;
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
}

function classifyHref(href) {
  const h = String(href || '');
  const isHomepage = h.includes(HOMEPAGE_URL_PATTERN);
  const isImWorkspace = h.includes(WORKSPACE_URL_PATTERN);
  return {
    isHomepage,
    isImWorkspace,
    isUnknown: Boolean(h) && !isHomepage && !isImWorkspace,
  };
}

module.exports = {
  IM_WATCH_TYPES,
  classifyHref,
  classifyBridgeKind,
  summarizeEvent,
  BridgeTracker,
};
