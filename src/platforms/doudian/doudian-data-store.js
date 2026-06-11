const Database = require('better-sqlite3');
const path = require('path');
const { resolveDataDir, ensureDir } = require('../../shared/app-root');
const { redactPayload } = require('../../shared/sensitive-redact');
const { getDoudianConfig } = require('../../shared/config');

let db = null;

function getDb() {
  if (db) return db;
  const verifyPath = process.env.DOUDIAN_VERIFY_DB;
  const dir = ensureDir(resolveDataDir());
  const file = verifyPath || path.join(dir, 'doudian-platform.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

function migrateSchema(database) {
  const cols = database.prepare(`PRAGMA table_info(platform_messages)`).all().map((r) => r.name);
  const addCol = (name, type) => {
    if (!cols.includes(name)) {
      database.exec(`ALTER TABLE platform_messages ADD COLUMN ${name} ${type}`);
    }
  };
  addCol('account_id', 'TEXT');
  addCol('session_partition_key', 'TEXT');
  addCol('source', 'TEXT');
  addCol('bridge_id', 'TEXT');
  addCol('page_href', 'TEXT');
  addCol('raw_text_hash', 'TEXT');
  addCol('message_timestamp', 'INTEGER');

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_platform_messages_shop ON platform_messages(platform, shop_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_platform_messages_dedupe ON platform_messages(platform, shop_id, conversation_id, raw_text_hash, message_timestamp);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS platform_capture_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'doudian',
      capture_type TEXT,
      is_ui_noise INTEGER DEFAULT 0,
      is_real_message_candidate INTEGER DEFAULT 0,
      api_name TEXT,
      shop_id TEXT,
      shop_name TEXT,
      conversation_id TEXT,
      buyer_id TEXT,
      message_id TEXT,
      text TEXT,
      source TEXT,
      bridge_type TEXT,
      bridge_id TEXT,
      page_href TEXT,
      raw_json TEXT,
      reject_reason TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_capture_candidates_type ON platform_capture_candidates(platform, capture_type, created_at);
  `);

  const candidateCols = database
    .prepare(`PRAGMA table_info(platform_capture_candidates)`)
    .all()
    .map((r) => r.name);
  if (candidateCols.length > 0 && !candidateCols.includes('reject_reason')) {
    database.exec(`ALTER TABLE platform_capture_candidates ADD COLUMN reject_reason TEXT`);
  }

  const convCols = database.prepare(`PRAGMA table_info(platform_conversations)`).all().map((r) => r.name);
  if (!convCols.includes('shop_name')) {
    database.exec(`ALTER TABLE platform_conversations ADD COLUMN shop_name TEXT`);
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS platform_outbound_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'doudian',
      shop_id TEXT,
      shop_name TEXT,
      conversation_id TEXT,
      buyer_id TEXT,
      buyer_name TEXT,
      text TEXT,
      status TEXT NOT NULL,
      send_method TEXT,
      verified_in_chat INTEGER DEFAULT 0,
      error_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outbound_messages_shop ON platform_outbound_messages(platform, shop_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_outbound_messages_conv ON platform_outbound_messages(platform, conversation_id, created_at);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS platform_reply_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'doudian',
      shop_id TEXT,
      shop_name TEXT,
      conversation_id TEXT,
      buyer_id TEXT,
      buyer_name TEXT,
      last_buyer_message TEXT,
      draft_text TEXT,
      draft_reason TEXT,
      risk_level TEXT DEFAULT 'low',
      status TEXT NOT NULL DEFAULT 'draft_only',
      source TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reply_drafts_conv ON platform_reply_drafts(platform, conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_reply_drafts_shop ON platform_reply_drafts(platform, shop_id, created_at);
  `);
}

function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS platform_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      shop_id TEXT,
      shop_name TEXT,
      conversation_id TEXT,
      buyer_id TEXT,
      buyer_name TEXT,
      message_id TEXT,
      direction TEXT,
      message_type TEXT,
      text TEXT,
      order_id TEXT,
      aftersale_id TEXT,
      raw_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS platform_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      shop_id TEXT,
      conversation_id TEXT NOT NULL,
      buyer_id TEXT,
      buyer_name TEXT,
      last_message TEXT,
      last_message_at INTEGER,
      unread_count INTEGER DEFAULT 0,
      takeover_status TEXT DEFAULT 'auto',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(platform, conversation_id)
    );

    CREATE TABLE IF NOT EXISTS platform_aftersales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      shop_id TEXT,
      aftersale_id TEXT,
      order_id TEXT,
      conversation_id TEXT,
      buyer_id TEXT,
      status TEXT,
      reason TEXT,
      amount TEXT,
      deadline TEXT,
      raw_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_platform_messages_msgid ON platform_messages(platform, message_id);
    CREATE INDEX IF NOT EXISTS idx_platform_messages_conv ON platform_messages(platform, conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_platform_aftersales_id ON platform_aftersales(platform, aftersale_id);
  `);
  migrateSchema(database);
}

function insertMessage(message) {
  const cfg = getDoudianConfig();
  const database = getDb();
  const now = Date.now();
  const rawJson = JSON.stringify(redactPayload(message.raw || {}, cfg.redactSensitiveFields));

  const stmt = database.prepare(`
    INSERT INTO platform_messages (
      platform, shop_id, shop_name, account_id, session_partition_key,
      conversation_id, buyer_id, buyer_name, message_id, direction, message_type,
      text, order_id, aftersale_id, source, bridge_id, page_href, raw_text_hash,
      message_timestamp, raw_json, created_at
    ) VALUES (
      @platform, @shop_id, @shop_name, @account_id, @session_partition_key,
      @conversation_id, @buyer_id, @buyer_name, @message_id, @direction, @message_type,
      @text, @order_id, @aftersale_id, @source, @bridge_id, @page_href, @raw_text_hash,
      @message_timestamp, @raw_json, @created_at
    )
  `);

  const result = stmt.run({
    platform: message.platform || 'doudian',
    shop_id: message.shopId || '',
    shop_name: message.shopName || '',
    account_id: message.accountId || '',
    session_partition_key: message.sessionPartitionKey || '',
    conversation_id: message.conversationId || '',
    buyer_id: message.buyerId || '',
    buyer_name: message.buyerName || '',
    message_id: message.messageId || '',
    direction: message.direction || 'buyer',
    message_type: message.messageType || 'text',
    text: message.text || '',
    order_id: message.orderId || '',
    aftersale_id: message.aftersaleId || '',
    source: message.source || '',
    bridge_id: message.bridgeId || '',
    page_href: message.pageHref || '',
    raw_text_hash: message.rawTextHash || '',
    message_timestamp: message.timestamp || now,
    raw_json: rawJson,
    created_at: now,
  });

  upsertConversation({
    platform: message.platform || 'doudian',
    shopId: message.shopId || '',
    shopName: message.shopName || '',
    conversationId: message.conversationId || '',
    buyerId: message.buyerId || '',
    buyerName: message.buyerName || '',
    lastMessage: message.text || '',
    lastMessageAt: message.timestamp || now,
    unreadCount: message.direction === 'inbound' ? 1 : 0,
    takeoverStatus: 'auto',
  });

  return { id: Number(result.lastInsertRowid), createdAt: now };
}

function insertCaptureCandidate(record) {
  const cfg = getDoudianConfig();
  const database = getDb();
  const now = Date.now();
  const rawJson = JSON.stringify(redactPayload(record.raw || {}, cfg.redactSensitiveFields));

  const stmt = database.prepare(`
    INSERT INTO platform_capture_candidates (
      platform, capture_type, is_ui_noise, is_real_message_candidate, api_name,
      shop_id, shop_name, conversation_id, buyer_id, message_id, text,
      source, bridge_type, bridge_id, page_href, raw_json, reject_reason, created_at
    ) VALUES (
      @platform, @capture_type, @is_ui_noise, @is_real_message_candidate, @api_name,
      @shop_id, @shop_name, @conversation_id, @buyer_id, @message_id, @text,
      @source, @bridge_type, @bridge_id, @page_href, @raw_json, @reject_reason, @created_at
    )
  `);

  return stmt.run({
    platform: record.platform || 'doudian',
    capture_type: record.captureType || '',
    is_ui_noise: record.isUiNoise ? 1 : 0,
    is_real_message_candidate: record.isRealMessageCandidate ? 1 : 0,
    api_name: record.apiName || '',
    shop_id: record.shopId || '',
    shop_name: record.shopName || '',
    conversation_id: record.conversationId || '',
    buyer_id: record.buyerId || '',
    message_id: record.messageId || '',
    text: record.text || '',
    source: record.source || '',
    bridge_type: record.bridgeType || '',
    bridge_id: record.bridgeId || '',
    page_href: record.pageHref || '',
    raw_json: rawJson,
    reject_reason: record.rejectReason || '',
    created_at: now,
  });
}

function upsertConversation(conv) {
  const database = getDb();
  const now = Date.now();
  const stmt = database.prepare(`
    INSERT INTO platform_conversations (
      platform, shop_id, conversation_id, buyer_id, buyer_name,
      last_message, last_message_at, unread_count, takeover_status, created_at, updated_at
    ) VALUES (
      @platform, @shop_id, @conversation_id, @buyer_id, @buyer_name,
      @last_message, @last_message_at, @unread_count, @takeover_status, @created_at, @updated_at
    )
    ON CONFLICT(platform, conversation_id) DO UPDATE SET
      shop_id = excluded.shop_id,
      buyer_id = COALESCE(excluded.buyer_id, platform_conversations.buyer_id),
      buyer_name = COALESCE(excluded.buyer_name, platform_conversations.buyer_name),
      last_message = excluded.last_message,
      last_message_at = excluded.last_message_at,
      unread_count = CASE
        WHEN excluded.unread_count > 0 THEN platform_conversations.unread_count + excluded.unread_count
        ELSE platform_conversations.unread_count
      END,
      takeover_status = COALESCE(platform_conversations.takeover_status, excluded.takeover_status),
      updated_at = excluded.updated_at
  `);

  const runResult = stmt.run({
    platform: conv.platform || 'doudian',
    shop_id: conv.shopId || '',
    conversation_id: conv.conversationId || '',
    buyer_id: conv.buyerId || '',
    buyer_name: conv.buyerName || '',
    last_message: conv.lastMessage || '',
    last_message_at: conv.lastMessageAt || now,
    unread_count: Number(conv.unreadCount || 0),
    takeover_status: conv.takeoverStatus || 'auto',
    created_at: now,
    updated_at: now,
  });
  return runResult;
}

function insertAftersale(record) {
  const cfg = getDoudianConfig();
  const database = getDb();
  const now = Date.now();
  const rawJson = JSON.stringify(redactPayload(record, cfg.redactSensitiveFields));

  const stmt = database.prepare(`
    INSERT INTO platform_aftersales (
      platform, shop_id, aftersale_id, order_id, conversation_id, buyer_id,
      status, reason, amount, deadline, raw_json, created_at, updated_at
    ) VALUES (
      @platform, @shop_id, @aftersale_id, @order_id, @conversation_id, @buyer_id,
      @status, @reason, @amount, @deadline, @raw_json, @created_at, @updated_at
    )
  `);

  return stmt.run({
    platform: record.platform || 'doudian',
    shop_id: record.shopId || '',
    aftersale_id: record.aftersaleId || '',
    order_id: record.orderId || '',
    conversation_id: record.conversationId || '',
    buyer_id: record.buyerId || '',
    status: record.status || '',
    reason: record.reason || '',
    amount: record.amount || '',
    deadline: record.deadline || '',
    raw_json: rawJson,
    created_at: now,
    updated_at: now,
  });
}

function getConversationTakeoverStatus(conversationId) {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT takeover_status FROM platform_conversations WHERE platform = 'doudian' AND conversation_id = ? LIMIT 1`
    )
    .get(conversationId);
  return row?.takeover_status || 'auto';
}

function setConversationTakeoverStatus(conversationId, status) {
  const database = getDb();
  return database
    .prepare(
      `UPDATE platform_conversations SET takeover_status = ?, updated_at = ? WHERE platform = 'doudian' AND conversation_id = ?`
    )
    .run(status, Date.now(), conversationId);
}

function hasRepliedMessage(messageId) {
  if (!messageId) return false;
  const database = getDb();
  const row = database
    .prepare(
      `SELECT id FROM platform_messages WHERE platform = 'doudian' AND direction = 'outbound' AND message_id = ? LIMIT 1`
    )
    .get(messageId);
  return Boolean(row);
}

function getLastInsertedMessage() {
  const database = getDb();
  return database
    .prepare(
      `SELECT id, platform, shop_id, shop_name, conversation_id, buyer_id, buyer_name,
              message_id, direction, message_type, text, source, bridge_id, created_at
       FROM platform_messages
       WHERE platform = 'doudian'
       ORDER BY id DESC
       LIMIT 1`
    )
    .get();
}

function getMessageById(rowId) {
  const database = getDb();
  return database
    .prepare(
      `SELECT id, platform, shop_id, shop_name, conversation_id, buyer_id, buyer_name,
              message_id, direction, message_type, text, source, bridge_id, created_at
       FROM platform_messages
       WHERE id = ?
       LIMIT 1`
    )
    .get(rowId);
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function findBadHistoryRows(options = {}) {
  const database = getDb();
  const sinceMs = Number(options.sinceMs || 0);
  const shopId = String(options.shopId || '213196845');
  const params = { shop_id: shopId };
  let sql = `
    SELECT id, platform, shop_id, shop_name, conversation_id, buyer_id, buyer_name,
           message_id, direction, message_type, text, source, bridge_id, page_href,
           raw_text_hash, message_timestamp, created_at
    FROM platform_messages
    WHERE platform = 'doudian'
      AND source = 'dom'
      AND shop_id = @shop_id
      AND (conversation_id IS NULL OR conversation_id = '')
      AND direction = 'unknown'
  `;
  if (sinceMs > 0) {
    sql += ' AND created_at >= @since_ms';
    params.since_ms = sinceMs;
  }
  sql += ' ORDER BY id ASC';
  return database.prepare(sql).all(params);
}

function migrateMessageRowToCandidate(row, rejectReason) {
  const database = getDb();
  insertCaptureCandidate({
    platform: row.platform || 'doudian',
    captureType: 'bad_history_rejected',
    isUiNoise: true,
    isRealMessageCandidate: false,
    shopId: row.shop_id || '',
    shopName: row.shop_name || '',
    conversationId: row.conversation_id || '',
    buyerId: row.buyer_id || '',
    messageId: row.message_id || '',
    text: row.text || '',
    source: row.source || 'dom',
    bridgeId: row.bridge_id || '',
    pageHref: row.page_href || '',
    rejectReason: rejectReason || 'bad_history_false_positive_wrong_shop_unknown_direction',
    raw: {
      migratedFromMessageId: row.id,
      direction: row.direction,
      rawTextHash: row.raw_text_hash,
      messageTimestamp: row.message_timestamp,
    },
  });
  database.prepare('DELETE FROM platform_messages WHERE id = ?').run(row.id);
}

function rowToMessage(row) {
  if (!row) return null;
  return {
    platform: row.platform,
    shopId: row.shop_id,
    shopName: row.shop_name,
    conversationId: row.conversation_id,
    buyerId: row.buyer_id,
    buyerName: row.buyer_name,
    messageId: row.message_id,
    direction: row.direction,
    messageType: row.message_type,
    text: row.text,
    source: row.source,
    timestamp: row.message_timestamp || row.created_at,
    created_at: row.created_at,
  };
}

function getLatestCapturedConversation(options = {}) {
  const database = getDb();
  const platform = options.platform || 'doudian';
  const row = database
    .prepare(
      `SELECT conversation_id, shop_id, shop_name, buyer_id, buyer_name, platform,
              MAX(COALESCE(message_timestamp, created_at)) AS last_at
       FROM platform_messages
       WHERE platform = @platform
         AND conversation_id IS NOT NULL
         AND conversation_id != ''
         AND direction IN ('buyer', 'seller', 'inbound', 'outbound')
       GROUP BY conversation_id
       ORDER BY last_at DESC
       LIMIT 1`
    )
    .get({ platform });
  return row || null;
}

function getRecentConversationMessages(conversationId, options = {}) {
  if (!conversationId) return [];
  const database = getDb();
  const platform = options.platform || 'doudian';
  const limit = Math.max(1, Math.min(Number(options.limit || 20), 50));
  const rows = database
    .prepare(
      `SELECT id, platform, shop_id, shop_name, conversation_id, buyer_id, buyer_name,
              message_id, direction, message_type, text, source, bridge_id,
              message_timestamp, created_at
       FROM platform_messages
       WHERE platform = @platform AND conversation_id = @conversation_id
       ORDER BY COALESCE(message_timestamp, created_at) ASC, id ASC`
    )
    .all({ platform, conversation_id: conversationId });

  return rows.slice(-limit).map(rowToMessage);
}

function insertReplyDraft(draft = {}) {
  const database = getDb();
  const now = Date.now();
  const status = String(draft.status || 'draft_only');
  if (status === 'sent' || status === 'auto_sent') {
    throw new Error('禁止写入 sent/auto_sent 状态');
  }

  const stmt = database.prepare(`
    INSERT INTO platform_reply_drafts (
      platform, shop_id, shop_name, conversation_id, buyer_id, buyer_name,
      last_buyer_message, draft_text, draft_reason, risk_level, status, source,
      created_at, updated_at
    ) VALUES (
      @platform, @shop_id, @shop_name, @conversation_id, @buyer_id, @buyer_name,
      @last_buyer_message, @draft_text, @draft_reason, @risk_level, @status, @source,
      @created_at, @updated_at
    )
  `);

  const result = stmt.run({
    platform: draft.platform || 'doudian',
    shop_id: draft.shopId || '',
    shop_name: draft.shopName || '',
    conversation_id: draft.conversationId || '',
    buyer_id: draft.buyerId || '',
    buyer_name: draft.buyerName || '',
    last_buyer_message: draft.lastBuyerMessage || '',
    draft_text: draft.draftText || '',
    draft_reason: draft.draftReason || '',
    risk_level: draft.riskLevel || 'low',
    status,
    source: draft.source || 'rule_generator',
    created_at: now,
    updated_at: now,
  });

  return { id: Number(result.lastInsertRowid), createdAt: now, status };
}

function getLatestDraftOnlyReply(options = {}) {
  const database = getDb();
  const platform = options.platform || 'doudian';
  const status = options.status || 'draft_only';
  return (
    database
      .prepare(
        `SELECT id, platform, shop_id, shop_name, conversation_id, buyer_id, buyer_name,
                last_buyer_message, draft_text, draft_reason, risk_level, status, source,
                created_at, updated_at
         FROM platform_reply_drafts
         WHERE platform = @platform AND status = @status
         ORDER BY id DESC
         LIMIT 1`
      )
      .get({ platform, status }) || null
  );
}

function getReplyDraftById(draftId) {
  const database = getDb();
  return database
    .prepare(
      `SELECT id, platform, shop_id, shop_name, conversation_id, buyer_id, buyer_name,
              last_buyer_message, draft_text, draft_reason, risk_level, status, source,
              created_at, updated_at
       FROM platform_reply_drafts
       WHERE id = ?
       LIMIT 1`
    )
    .get(draftId);
}

const OUTBOUND_STATUSES = new Set(['pending', 'sent', 'sent_unverified', 'failed', 'blocked']);

function insertOutboundMessage(record = {}) {
  const database = getDb();
  const now = Date.now();
  const status = String(record.status || 'pending');
  if (!OUTBOUND_STATUSES.has(status)) {
    throw new Error(`非法 outbound status: ${status}`);
  }
  const stmt = database.prepare(`
    INSERT INTO platform_outbound_messages (
      platform, shop_id, shop_name, conversation_id, buyer_id, buyer_name,
      text, status, send_method, verified_in_chat, error_reason, created_at, updated_at
    ) VALUES (
      @platform, @shop_id, @shop_name, @conversation_id, @buyer_id, @buyer_name,
      @text, @status, @send_method, @verified_in_chat, @error_reason, @created_at, @updated_at
    )
  `);
  const result = stmt.run({
    platform: record.platform || 'doudian',
    shop_id: record.shopId || '',
    shop_name: record.shopName || '',
    conversation_id: record.conversationId || '',
    buyer_id: record.buyerId || '',
    buyer_name: record.buyerName || '',
    text: record.text || '',
    status,
    send_method: record.sendMethod || 'ui',
    verified_in_chat: record.verifiedInChat ? 1 : 0,
    error_reason: record.errorReason || '',
    created_at: now,
    updated_at: now,
  });
  return { id: Number(result.lastInsertRowid), createdAt: now, status };
}

function updateOutboundMessage(id, updates = {}) {
  const database = getDb();
  const status = updates.status ? String(updates.status) : '';
  if (status && !OUTBOUND_STATUSES.has(status)) {
    throw new Error(`非法 outbound status: ${status}`);
  }
  const now = Date.now();
  database
    .prepare(
      `UPDATE platform_outbound_messages
       SET status = COALESCE(@status, status),
           verified_in_chat = COALESCE(@verified_in_chat, verified_in_chat),
           error_reason = COALESCE(@error_reason, error_reason),
           updated_at = @updated_at
       WHERE id = @id`
    )
    .run({
      id: Number(id),
      status: status || null,
      verified_in_chat:
        updates.verifiedInChat === undefined ? null : updates.verifiedInChat ? 1 : 0,
      error_reason: updates.errorReason === undefined ? null : updates.errorReason || '',
      updated_at: now,
    });
  return getOutboundMessageById(id);
}

function getOutboundMessageById(id) {
  const database = getDb();
  return (
    database
      .prepare(
        `SELECT id, platform, shop_id, shop_name, conversation_id, buyer_id, buyer_name,
                text, status, send_method, verified_in_chat, error_reason, created_at, updated_at
         FROM platform_outbound_messages WHERE id = ? LIMIT 1`
      )
      .get(Number(id)) || null
  );
}

function getLatestOutboundMessage() {
  const database = getDb();
  return (
    database
      .prepare(
        `SELECT id, platform, shop_id, shop_name, conversation_id, buyer_id, buyer_name,
                text, status, send_method, verified_in_chat, error_reason, created_at, updated_at
         FROM platform_outbound_messages
         WHERE platform = 'doudian'
         ORDER BY id DESC
         LIMIT 1`
      )
      .get() || null
  );
}

function cleanupBadHistoryRows(options = {}) {
  const rows = findBadHistoryRows(options);
  let migrated = 0;
  for (const row of rows) {
    migrateMessageRowToCandidate(
      row,
      options.rejectReason || 'bad_history_false_positive_wrong_shop_unknown_direction'
    );
    migrated += 1;
  }
  return {
    badRowsFound: rows.length,
    badRowsDeleted: migrated,
    badRowsMigratedToCandidates: migrated,
  };
}

module.exports = {
  getDb,
  insertMessage,
  insertCaptureCandidate,
  getLastInsertedMessage,
  getMessageById,
  getLatestCapturedConversation,
  getRecentConversationMessages,
  insertReplyDraft,
  getReplyDraftById,
  getLatestDraftOnlyReply,
  upsertConversation,
  insertAftersale,
  getConversationTakeoverStatus,
  setConversationTakeoverStatus,
  hasRepliedMessage,
  findBadHistoryRows,
  migrateMessageRowToCandidate,
  cleanupBadHistoryRows,
  insertOutboundMessage,
  updateOutboundMessage,
  getOutboundMessageById,
  getLatestOutboundMessage,
  OUTBOUND_STATUSES,
  closeDb,
};
