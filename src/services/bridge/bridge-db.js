const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const { resolveDataDir, ensureDir } = require('../../shared/app-root');
const { bridgeLog } = require('../../shared/bridge-log');

let db = null;

function getBridgeDb() {
  if (db) return db;
  const verifyPath = process.env.CDP_BRIDGE_DB;
  const file = verifyPath || path.join(ensureDir(resolveDataDir()), 'cdp-bridge.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  initBridgeSchema(db);
  return db;
}

function initBridgeSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ws_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_key TEXT UNIQUE,
      source TEXT,
      target_id TEXT,
      socket_id TEXT,
      request_id TEXT,
      url TEXT,
      shop_id TEXT,
      shop_name TEXT,
      page_title TEXT,
      page_url TEXT,
      opened_at TEXT,
      closed_at TEXT,
      last_seen_at TEXT,
      status TEXT
    );

    CREATE TABLE IF NOT EXISTS ws_frames (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT UNIQUE,
      source TEXT,
      direction TEXT,
      target_id TEXT,
      socket_id TEXT,
      request_id TEXT,
      url TEXT,
      payload_type TEXT,
      payload_text TEXT,
      payload_base64 TEXT,
      payload_length INTEGER,
      payload_hash TEXT,
      shop_id TEXT,
      shop_name TEXT,
      page_title TEXT,
      page_url TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS business_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT UNIQUE,
      frame_dedupe_key TEXT,
      msg_id TEXT,
      app_cid TEXT,
      conversation_id TEXT,
      buyer_id TEXT,
      sender TEXT,
      direction TEXT,
      content TEXT,
      message_type TEXT,
      raw_json TEXT,
      confidence REAL,
      shop_id TEXT,
      shop_name TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS bridge_runtime_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE,
      value TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS bridge_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module TEXT,
      level TEXT,
      message TEXT,
      detail TEXT,
      target_id TEXT,
      created_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_ws_frames_created ON ws_frames(created_at);
    CREATE INDEX IF NOT EXISTS idx_business_messages_created ON business_messages(created_at);
  `);
}

function hashPayload(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 32);
}

class BridgeDb {
  constructor(database) {
    this.db = database || getBridgeDb();
  }

  upsertConnection(row) {
    const key = `${row.targetId || ''}:${row.requestId || row.socketId || ''}:${row.url || ''}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO ws_connections (connection_key, source, target_id, socket_id, request_id, url, shop_id, shop_name, page_title, page_url, opened_at, last_seen_at, status)
         VALUES (@connection_key, @source, @target_id, @socket_id, @request_id, @url, @shop_id, @shop_name, @page_title, @page_url, @opened_at, @last_seen_at, @status)
         ON CONFLICT(connection_key) DO UPDATE SET last_seen_at=@last_seen_at, status=@status`
      )
      .run({
        connection_key: key,
        source: row.source || '',
        target_id: row.targetId || '',
        socket_id: row.socketId || '',
        request_id: row.requestId || '',
        url: row.url || '',
        shop_id: row.shopId || 'unknown',
        shop_name: row.shopName || 'unknown',
        page_title: row.pageTitle || '',
        page_url: row.pageUrl || '',
        opened_at: now,
        last_seen_at: now,
        status: 'open',
      });
  }

  insertFrame(row) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ws_frames (dedupe_key, source, direction, target_id, socket_id, request_id, url, payload_type, payload_text, payload_base64, payload_length, payload_hash, shop_id, shop_name, page_title, page_url, created_at)
         VALUES (@dedupe_key, @source, @direction, @target_id, @socket_id, @request_id, @url, @payload_type, @payload_text, @payload_base64, @payload_length, @payload_hash, @shop_id, @shop_name, @page_title, @page_url, @created_at)`
      )
      .run({
        dedupe_key: row.dedupeKey,
        source: row.source,
        direction: row.direction,
        target_id: row.targetId,
        socket_id: row.socketId,
        request_id: row.requestId,
        url: row.url,
        payload_type: row.payloadType,
        payload_text: row.payloadText,
        payload_base64: row.payloadBase64,
        payload_length: row.payloadLength,
        payload_hash: hashPayload(row.payloadText),
        shop_id: row.shopId,
        shop_name: row.shopName,
        page_title: row.pageTitle,
        page_url: row.pageUrl,
        created_at: new Date(row.timestamp || Date.now()).toISOString(),
      });
  }

  insertBusinessMessage(row) {
    if (!row || row.raw) return;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO business_messages (dedupe_key, frame_dedupe_key, msg_id, app_cid, conversation_id, buyer_id, sender, direction, content, message_type, raw_json, confidence, shop_id, shop_name, created_at)
         VALUES (@dedupe_key, @frame_dedupe_key, @msg_id, @app_cid, @conversation_id, @buyer_id, @sender, @direction, @content, @message_type, @raw_json, @confidence, @shop_id, @shop_name, @created_at)`
      )
      .run({
        dedupe_key: row.dedupeKey,
        frame_dedupe_key: row.frameDedupeKey,
        msg_id: row.msgId || '',
        app_cid: row.appCid || '',
        conversation_id: row.conversationId || '',
        buyer_id: row.buyerId || '',
        sender: row.sender || '',
        direction: row.direction || '',
        content: row.content || '',
        message_type: row.messageType || '',
        raw_json: row.rawJson || '',
        confidence: row.confidence || 0,
        shop_id: row.shopId || 'unknown',
        shop_name: row.shopName || 'unknown',
        created_at: row.createdAt || new Date().toISOString(),
      });
  }

  insertError(module, message, detail, targetId = '') {
    this.db
      .prepare(
        `INSERT INTO bridge_errors (module, level, message, detail, target_id, created_at) VALUES (?, 'error', ?, ?, ?, ?)`
      )
      .run(module, message, String(detail || '').slice(0, 4000), targetId, new Date().toISOString());
  }

  setStatus(key, value) {
    this.db
      .prepare(
        `INSERT INTO bridge_runtime_status (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
      )
      .run(key, String(value), new Date().toISOString());
  }

  getRecentFrames(limit = 20) {
    return this.db
      .prepare(`SELECT * FROM ws_frames ORDER BY id DESC LIMIT ?`)
      .all(limit)
      .reverse();
  }

  getRecentBusiness(limit = 20) {
    return this.db
      .prepare(`SELECT * FROM business_messages ORDER BY id DESC LIMIT ?`)
      .all(limit)
      .reverse();
  }

  getConnections(limit = 50) {
    return this.db.prepare(`SELECT * FROM ws_connections ORDER BY id DESC LIMIT ?`).all(limit);
  }

  getErrors(limit = 20) {
    return this.db.prepare(`SELECT * FROM bridge_errors ORDER BY id DESC LIMIT ?`).all(limit);
  }

  countFrames() {
    return this.db.prepare(`SELECT COUNT(*) AS c FROM ws_frames`).get()?.c || 0;
  }
}

function closeBridgeDb() {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
    db = null;
  }
}

module.exports = {
  BridgeDb,
  getBridgeDb,
  closeBridgeDb,
  initBridgeSchema,
};
