const crypto = require('crypto');
const { getDoudianConfig } = require('../../shared/config');
const { buildShopKey, hashText } = require('./doudian-shop-utils');

const TIME_BUCKET_MS = 10000;

class DoudianDedupe {
  constructor(options = {}) {
    const cfg = getDoudianConfig();
    this.windowMs = Number(options.dedupeWindowMs || cfg.dedupeWindowMs || 60000);
    this.mergeWindowMs = Number(options.messageMergeWindowMs || cfg.messageMergeWindowMs || 8000);
    this.timeBucketMs = Number(options.timeBucketMs || TIME_BUCKET_MS);
    this.seen = new Map();
    this.mergeBuckets = new Map();
    this.maxEntries = Number(options.maxEntries || 10000);
  }

  normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  resolveShopKey(message) {
    return buildShopKey({
      shopId: message.shopId,
      sessionPartitionKey: message.sessionPartitionKey,
      bridgeId: message.bridgeId,
    });
  }

  buildKey(message) {
    const shopKey = this.resolveShopKey(message);
    const messageId = String(message.messageId || '').trim();
    if (messageId && !messageId.startsWith('dom-')) {
      return `doudian:${shopKey}:messageId:${messageId}`;
    }

    const textHash = message.rawTextHash || hashText(this.normalizeText(message.text));
    const direction = message.direction || 'unknown';
    const ts = Number(message.timestamp || Date.now());
    const timeBucket = Math.floor(ts / this.timeBucketMs);
    const conversationId = String(message.conversationId || '').trim();

    if (conversationId) {
      return `doudian:${shopKey}:${conversationId}:${direction}:${textHash}:${timeBucket}`;
    }

    const buyerId = String(message.buyerId || '').trim();
    if (buyerId) {
      return `doudian:${shopKey}:${buyerId}:${direction}:${textHash}:${timeBucket}`;
    }

    const bridgeId = String(message.bridgeId || 'na');
    return `doudian:${shopKey}:${bridgeId}:${direction}:${textHash}:${timeBucket}`;
  }

  isDuplicate(message) {
    const key = this.buildKey(message);
    const now = Date.now();
    const prev = this.seen.get(key);
    if (prev && now - prev < this.windowMs * 2) {
      return true;
    }
    this.seen.set(key, now);
    this.trim();
    return false;
  }

  shouldMerge(message) {
    const shopKey = this.resolveShopKey(message);
    const conversationId = String(message.conversationId || '').trim() || `${shopKey}::__unknown__`;
    const direction = message.direction || 'inbound';
    if (direction !== 'inbound' && direction !== 'buyer') return false;

    const now = Date.now();
    const bucket = this.mergeBuckets.get(conversationId);
    if (!bucket) {
      this.mergeBuckets.set(conversationId, { lastAt: now, count: 1, texts: [message.text || ''] });
      return false;
    }

    if (now - bucket.lastAt <= this.mergeWindowMs) {
      bucket.lastAt = now;
      bucket.count += 1;
      bucket.texts.push(message.text || '');
      return bucket.count > 1;
    }

    this.mergeBuckets.set(conversationId, { lastAt: now, count: 1, texts: [message.text || ''] });
    return false;
  }

  getMergedText(conversationId) {
    const bucket = this.mergeBuckets.get(conversationId);
    if (!bucket) return '';
    return bucket.texts.filter(Boolean).join('\n');
  }

  clearMerge(conversationId) {
    this.mergeBuckets.delete(conversationId);
  }

  trim() {
    if (this.seen.size <= this.maxEntries) return;
    const entries = [...this.seen.entries()].sort((a, b) => a[1] - b[1]);
    const drop = Math.floor(this.maxEntries / 2);
    for (let i = 0; i < drop; i++) {
      this.seen.delete(entries[i][0]);
    }
  }
}

module.exports = {
  DoudianDedupe,
  TIME_BUCKET_MS,
};
