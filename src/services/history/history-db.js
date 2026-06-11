const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const { resolveDataDir, ensureDir } = require('../../shared/app-root');
const { historyLog } = require('../../shared/history-log');

let db = null;

function getHistoryDb() {
  if (db) return db;
  const file = process.env.HISTORY_SYNC_DB || path.join(ensureDir(resolveDataDir()), 'history-sync.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  initHistorySchema(db);
  return db;
}

function initHistorySchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT,
      shop_id TEXT,
      shop_name TEXT,
      conversation_id TEXT,
      buyer_id TEXT,
      buyer_name TEXT,
      last_message_time TEXT,
      last_message_content TEXT,
      source TEXT,
      raw_json TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(shop_id, conversation_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT,
      shop_id TEXT,
      shop_name TEXT,
      conversation_id TEXT,
      buyer_id TEXT,
      buyer_name TEXT,
      msg_id TEXT,
      direction TEXT,
      content TEXT,
      message_type TEXT,
      send_time TEXT,
      source TEXT,
      confidence REAL,
      content_hash TEXT,
      raw_json TEXT,
      created_at TEXT,
      UNIQUE(shop_id, msg_id)
    );

    CREATE TABLE IF NOT EXISTS history_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT UNIQUE,
      platform TEXT,
      shop_id TEXT,
      shop_name TEXT,
      start_time TEXT,
      end_time TEXT,
      status TEXT,
      scanned_conversations INTEGER,
      inserted_messages INTEGER,
      updated_messages INTEGER,
      skipped_duplicates INTEGER,
      error_count INTEGER,
      report_path TEXT,
      reused_existing_client INTEGER,
      killed_existing_client INTEGER,
      relaunched_client INTEGER,
      created_at TEXT,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS history_sync_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      module TEXT,
      level TEXT,
      message TEXT,
      detail TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS history_sync_status (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(shop_id, conversation_id, send_time);
    CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(send_time);
  `);
}

function hashContent(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 32);
}

function fallbackMsgId(row) {
  return hashContent(`${row.conversationId}|${row.sendTime}|${row.direction}|${row.content}`).slice(0, 24);
}

class HistoryDb {
  constructor(database) {
    this.db = database || getHistoryDb();
  }

  hasAnyMessages() {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM messages').get();
    return (row?.c || 0) > 0;
  }

  getLastMessageTime(shopId) {
    const row = this.db
      .prepare(`SELECT MAX(send_time) AS t FROM messages WHERE shop_id = ?`)
      .get(shopId || '');
    return row?.t || '';
  }

  setStatus(key, value) {
    this.db
      .prepare(
        `INSERT INTO history_sync_status (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
      )
      .run(key, String(value), new Date().toISOString());
  }

  getStatus(key, defaultValue = '') {
    const row = this.db.prepare(`SELECT value FROM history_sync_status WHERE key = ?`).get(key);
    return row?.value ?? defaultValue;
  }

  startRun(runMeta) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO history_sync_runs (run_id, platform, shop_id, shop_name, start_time, status, scanned_conversations, inserted_messages, updated_messages, skipped_duplicates, error_count, reused_existing_client, killed_existing_client, relaunched_client, created_at)
         VALUES (@run_id, @platform, @shop_id, @shop_name, @start_time, 'running', 0, 0, 0, 0, 0, @reused, @killed, @relaunched, @created_at)`
      )
      .run({
        run_id: runMeta.runId,
        platform: runMeta.platform || 'doudian',
        shop_id: runMeta.shopId || '',
        shop_name: runMeta.shopName || '',
        start_time: runMeta.startTime || now,
        reused: runMeta.reusedExistingClient ? 1 : 0,
        killed: runMeta.killedExistingClient ? 1 : 0,
        relaunched: runMeta.relaunchedClient ? 1 : 0,
        created_at: now,
      });
  }

  finishRun(runId, stats) {
    this.db
      .prepare(
        `UPDATE history_sync_runs SET status=@status, end_time=@end_time, scanned_conversations=@scanned, inserted_messages=@inserted, updated_messages=@updated, skipped_duplicates=@skipped, error_count=@errors, report_path=@report_path, finished_at=@finished_at WHERE run_id=@run_id`
      )
      .run({
        run_id: runId,
        status: stats.status || 'failed',
        end_time: stats.endTime || new Date().toISOString(),
        scanned: stats.scannedConversations || 0,
        inserted: stats.insertedMessages || 0,
        updated: stats.updatedMessages || 0,
        skipped: stats.skippedDuplicates || 0,
        errors: stats.errorCount || 0,
        report_path: stats.reportPath || '',
        finished_at: new Date().toISOString(),
      });
  }

  insertError(runId, module, message, detail) {
    this.db
      .prepare(
        `INSERT INTO history_sync_errors (run_id, module, level, message, detail, created_at) VALUES (?, 'error', ?, ?, ?, ?)`
      )
      .run(runId, module, message, String(detail || '').slice(0, 4000), new Date().toISOString());
  }

  upsertConversation(row) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO conversations (platform, shop_id, shop_name, conversation_id, buyer_id, buyer_name, last_message_time, last_message_content, source, raw_json, created_at, updated_at)
         VALUES (@platform, @shop_id, @shop_name, @conversation_id, @buyer_id, @buyer_name, @last_message_time, @last_message_content, @source, @raw_json, @created_at, @updated_at)
         ON CONFLICT(shop_id, conversation_id) DO UPDATE SET
           buyer_name=excluded.buyer_name,
           last_message_time=excluded.last_message_time,
           last_message_content=excluded.last_message_content,
           source=excluded.source,
           updated_at=excluded.updated_at`
      )
      .run({
        platform: row.platform || 'unknown',
        shop_id: row.shopId || 'unknown',
        shop_name: row.shopName || 'unknown',
        conversation_id: row.conversationId || '',
        buyer_id: row.buyerId || '',
        buyer_name: row.buyerName || '',
        last_message_time: row.lastMessageTime || row.sendTime || '',
        last_message_content: String(row.content || '').slice(0, 500),
        source: row.source || '',
        raw_json: String(row.rawJson || '').slice(0, 8000),
        created_at: now,
        updated_at: now,
      });
  }

  insertMessage(row) {
    const msgId = row.msgId || fallbackMsgId(row);
    const contentHash = hashContent(row.content);
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (platform, shop_id, shop_name, conversation_id, buyer_id, buyer_name, msg_id, direction, content, message_type, send_time, source, confidence, content_hash, raw_json, created_at)
         VALUES (@platform, @shop_id, @shop_name, @conversation_id, @buyer_id, @buyer_name, @msg_id, @direction, @content, @message_type, @send_time, @source, @confidence, @content_hash, @raw_json, @created_at)`
      )
      .run({
        platform: row.platform || 'unknown',
        shop_id: row.shopId || 'unknown',
        shop_name: row.shopName || 'unknown',
        conversation_id: row.conversationId || '',
        buyer_id: row.buyerId || '',
        buyer_name: row.buyerName || '',
        msg_id: msgId,
        direction: row.direction || 'unknown',
        content: String(row.content || '').slice(0, 5000),
        message_type: row.messageType || 'text',
        send_time: row.sendTime || new Date().toISOString(),
        source: row.source || '',
        confidence: row.confidence || 0,
        content_hash: contentHash,
        raw_json: String(row.raw || row.rawJson || '').slice(0, 8000),
        created_at: new Date().toISOString(),
      });
    return { inserted: info.changes > 0, msgId };
  }

  getRecentMessages({ shopId, conversationId, limit = 20 }) {
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE shop_id = ? AND conversation_id = ? ORDER BY send_time ASC LIMIT ?`
      )
      .all(shopId, conversationId, limit);
  }

  countMessages() {
    return this.db.prepare('SELECT COUNT(*) AS c FROM messages').get()?.c || 0;
  }

  countConversations() {
    return this.db.prepare('SELECT COUNT(*) AS c FROM conversations').get()?.c || 0;
  }
}

function closeHistoryDb() {
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
  HistoryDb,
  getHistoryDb,
  closeHistoryDb,
  initHistorySchema,
  hashContent,
};
