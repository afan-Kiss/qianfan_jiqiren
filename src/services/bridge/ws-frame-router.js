const crypto = require('crypto');
const { getCdpBridgeConfig } = require('../../shared/config');
const { bridgeLog } = require('../../shared/bridge-log');

class WsFrameRouter {
  constructor(options = {}) {
    this.db = options.db || null;
    this.extractor = options.extractor || null;
    this.debugPayload = Boolean(options.debugPayload);
    this.saveRawFrames = options.saveRawFrames !== false;
    this.maxLength = Number(options.savePayloadMaxLength || 20000);
    this.recentFrames = [];
    this.recentBusiness = [];
    this.stats = {
      routed: 0,
      deduped: 0,
      rateLimited: 0,
      connections: 0,
    };
    this.dedupeKeys = new Set();
    this.lastSecondCount = 0;
    this.secondBucket = Math.floor(Date.now() / 1000);
    this.maxPerSecond = Number(options.maxFramesPerSecond || 200);
    this.onBusiness = typeof options.onBusiness === 'function' ? options.onBusiness : null;
  }

  hashText(text) {
    return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 32);
  }

  buildDedupeKey(row) {
    const base = [
      row.source,
      row.direction,
      row.targetId,
      row.requestId || row.socketId,
      row.url || '',
      this.hashText(row.payloadText || '').slice(0, 16),
      Math.floor((row.timestamp || Date.now()) / 500),
    ].join('|');
    return base;
  }

  rateLimitOk() {
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== this.secondBucket) {
      this.secondBucket = sec;
      this.lastSecondCount = 0;
    }
    if (this.lastSecondCount >= this.maxPerSecond) {
      this.stats.rateLimited += 1;
      return false;
    }
    this.lastSecondCount += 1;
    return true;
  }

  trimPayload(text) {
    const s = String(text || '');
    if (s.length <= this.maxLength) return s;
    return s.slice(0, this.maxLength) + '...[truncated]';
  }

  route(raw) {
    if (!this.rateLimitOk()) return null;

    const row = {
      source: raw.source || 'unknown',
      direction: raw.direction || 'unknown',
      targetId: raw.targetId || '',
      socketId: raw.socketId || '',
      requestId: raw.requestId || '',
      url: raw.url || '',
      payloadType: raw.payloadType || (raw.payloadText ? 'string' : 'unknown'),
      payloadText: this.trimPayload(raw.payloadText || ''),
      payloadBase64: raw.payloadBase64 || '',
      payloadLength: String(raw.payloadText || '').length,
      shopId: raw.shopId || 'unknown',
      shopName: raw.shopName || 'unknown',
      pageTitle: raw.pageTitle || '',
      pageUrl: raw.pageUrl || '',
      platform: raw.platform || 'unknown',
      timestamp: raw.timestamp || Date.now(),
      kind: raw.kind || 'ws_frame',
    };

    row.dedupeKey = this.buildDedupeKey(row);
    if (this.dedupeKeys.has(row.dedupeKey)) {
      this.stats.deduped += 1;
      return null;
    }
    this.dedupeKeys.add(row.dedupeKey);
    if (this.dedupeKeys.size > 50000) {
      this.dedupeKeys.clear();
    }

    this.stats.routed += 1;
    if (row.kind === 'ws_created' || row.kind === 'ws_open') this.stats.connections += 1;

    if (this.debugPayload) {
      bridgeLog('[WS_FRAME]', `${row.source} ${row.direction} ${row.url.slice(0, 60)}`, row.payloadText.slice(0, 120));
    } else if (row.kind === 'ws_frame' || row.kind === 'ws_message' || row.kind === 'ws_send') {
      bridgeLog('[WS_ROUTE]', `${row.source} ${row.direction} len=${row.payloadLength} url=${row.url.slice(0, 50)}`);
    }

    this.recentFrames.push({
      dedupeKey: row.dedupeKey,
      source: row.source,
      direction: row.direction,
      url: row.url,
      payloadLength: row.payloadLength,
      payloadPreview: row.payloadText.slice(0, 120),
      timestamp: row.timestamp,
    });
    if (this.recentFrames.length > 100) this.recentFrames.shift();

    if (this.db && this.saveRawFrames) {
      try {
        this.db.insertFrame(row);
        if (row.kind === 'ws_created' || row.kind === 'ws_open') {
          this.db.upsertConnection(row);
        }
      } catch (err) {
        bridgeLog('[BRIDGE_ERROR]', '[BRIDGE_DB] insertFrame failed', String(err.message || err));
      }
    }

    if (this.extractor && (row.kind === 'ws_frame' || row.kind === 'ws_message' || row.kind === 'ws_send')) {
      const biz = this.extractor.extract(row);
      if (biz) {
        this.recentBusiness.push(biz);
        if (this.recentBusiness.length > 100) this.recentBusiness.shift();
        if (this.db) {
          try {
            this.db.insertBusinessMessage(biz);
          } catch (err) {
            bridgeLog('[BRIDGE_ERROR]', '[BRIDGE_DB] insertBusinessMessage failed', String(err.message || err));
          }
        }
        if (!biz.raw && this.onBusiness) {
          try {
            this.onBusiness(biz);
          } catch {
            // ignore
          }
        }
      }
    }

    return row;
  }

  getRecentFrames(limit = 20) {
    return this.recentFrames.slice(-limit);
  }

  getRecentBusiness(limit = 20) {
    return this.recentBusiness.slice(-limit);
  }
}

module.exports = {
  WsFrameRouter,
};
