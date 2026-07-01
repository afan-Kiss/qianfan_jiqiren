/**
 * 千帆纯协议守护 — 消息去重（内存 + 本地文件）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveProjectRoot } = require('../shared/app-root');

const DEFAULT_MAX_KEYS = 20000;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function dedupStorePath() {
  return path.join(resolveProjectRoot(), 'data', 'qianfan-protocol-daemon-dedup.json');
}

function hashContent(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 12);
}

function buildMessageDedupKey(shopId, message = {}) {
  const shop = String(shopId || '').trim();
  const msgId = String(message.msgId || message.messageId || '').trim();
  if (msgId) return `${shop}::id::${msgId}`;
  const appCid = String(message.appCid || '').trim();
  const createAt = Number(message.createAt || message.timestamp || 0) || 0;
  const contentHash = hashContent(message.text || message.content || '');
  return `${shop}::${appCid}::${createAt}::${contentHash}`;
}

class MessageDedupStore {
  constructor(options = {}) {
    this.maxKeys = Number(options.maxKeys || DEFAULT_MAX_KEYS);
    this.ttlMs = Number(options.ttlMs || DEFAULT_TTL_MS);
    this.filePath = options.filePath || dedupStorePath();
    this.entries = new Map();
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const rows = Array.isArray(raw?.keys) ? raw.keys : [];
      const now = Date.now();
      for (const row of rows) {
        if (!row?.key) continue;
        if (row.at && now - row.at > this.ttlMs) continue;
        this.entries.set(row.key, row.at || now);
      }
    } catch {
      this.entries.clear();
    }
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const keys = [...this.entries.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, this.maxKeys)
        .map(([key, at]) => ({ key, at }));
      fs.writeFileSync(this.filePath, JSON.stringify({ updatedAt: Date.now(), keys }, null, 2), 'utf8');
    } catch {
      // ignore persist errors
    }
  }

  _prune() {
    const now = Date.now();
    for (const [key, at] of this.entries.entries()) {
      if (now - at > this.ttlMs) this.entries.delete(key);
    }
    while (this.entries.size > this.maxKeys) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1] - b[1])[0];
      if (!oldest) break;
      this.entries.delete(oldest[0]);
    }
  }

  has(key) {
    const at = this.entries.get(key);
    if (!at) return false;
    if (Date.now() - at > this.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  remember(key) {
    this.entries.set(key, Date.now());
    this._prune();
    this._persist();
  }

  tryConsume(shopId, message) {
    const key = buildMessageDedupKey(shopId, message);
    if (this.has(key)) return { duplicate: true, key };
    this.remember(key);
    return { duplicate: false, key };
  }
}

module.exports = {
  MessageDedupStore,
  buildMessageDedupKey,
  dedupStorePath,
};
