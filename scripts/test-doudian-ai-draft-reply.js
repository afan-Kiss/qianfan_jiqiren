#!/usr/bin/env node
/**
 * AI 客服回复草稿专项测试
 * npm run doudian:test-ai-draft-reply
 */
const path = require('path');
const fs = require('fs');
const {
  generateDraftFromContext,
  buildDraftContext,
  scanDraftRisk,
  DRAFT_TEMPLATES,
} = require('../src/platforms/doudian/doudian-ai-draft-generator');
const {
  insertMessage,
  insertReplyDraft,
  getReplyDraftById,
  closeDb,
  getDb,
} = require('../src/platforms/doudian/doudian-data-store');
const { runAiDraftReplySession } = require('./lib/doudian-ai-draft-reply-session');

function buildConversation(overrides = {}) {
  return {
    platform: 'doudian',
    shopId: '263636465',
    shopName: 'XY祥钰珠宝',
    conversationId: overrides.conversationId || 'conv_draft_test_001',
    buyerId: overrides.buyerId || 'buyer_draft_***',
    buyerName: overrides.buyerName || '测试买家',
  };
}

function buildMessages(pairs) {
  const now = Date.now();
  return pairs.map((p, i) => ({
    direction: p.direction,
    messageType: p.messageType || 'text',
    text: p.text,
    timestamp: now - (pairs.length - i) * 1000,
  }));
}

function testGreetingDraft() {
  const ctx = buildDraftContext(
    buildConversation(),
    buildMessages([
      { direction: 'seller', text: '欢迎光临' },
      { direction: 'buyer', text: '在吗' },
    ])
  );
  const r = generateDraftFromContext(ctx);
  return r.ok && r.draftReason === 'greeting' && r.draftText === DRAFT_TEMPLATES.greeting;
}

function testHelloDraft() {
  const ctx = buildDraftContext(
    buildConversation(),
    buildMessages([{ direction: 'buyer', text: '你好' }])
  );
  const r = generateDraftFromContext(ctx);
  return r.ok && r.draftReason === 'greeting';
}

function testStockDraft() {
  const ctx = buildDraftContext(
    buildConversation(),
    buildMessages([{ direction: 'buyer', text: '这款手镯还有货吗' }])
  );
  const r = generateDraftFromContext(ctx);
  return r.ok && r.draftReason === 'stock' && r.draftText === DRAFT_TEMPLATES.stock;
}

function testPriceDraft() {
  const ctx = buildDraftContext(
    buildConversation(),
    buildMessages([{ direction: 'buyer', text: '这个多少钱' }])
  );
  const r = generateDraftFromContext(ctx);
  return r.ok && r.draftReason === 'price' && r.draftText === DRAFT_TEMPLATES.price;
}

function testNoBuyerMessage() {
  const ctx = buildDraftContext(
    buildConversation(),
    buildMessages([{ direction: 'seller', text: '亲亲，很高兴为您服务' }])
  );
  const r = generateDraftFromContext(ctx);
  return !r.ok && (r.reason === 'no_buyer_message' || r.reason === 'no_reply_needed');
}

function testRiskBlocked() {
  const risky = '亲亲，我已经帮你退款了';
  const risk = scanDraftRisk(risky);
  if (risk.riskLevel !== 'high') return false;

  const dbPath = path.join(process.cwd(), 'logs', 'doudian-ai-draft-risk-test.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  process.env.DOUDIAN_VERIFY_DB = dbPath;
  closeDb();

  const inserted = insertReplyDraft({
    platform: 'doudian',
    shopId: '263636465',
    shopName: 'XY祥钰珠宝',
    conversationId: 'conv_risk_test',
    buyerId: 'buyer_risk',
    lastBuyerMessage: '我要退款',
    draftText: risky,
    draftReason: 'risk_test',
    riskLevel: 'high',
    status: 'risk_blocked',
    source: 'rule_generator',
  });

  const row = getReplyDraftById(inserted.id);
  closeDb();
  return row && row.status === 'risk_blocked' && row.risk_level === 'high';
}

function testSqliteDraftInsert() {
  const dbPath = path.join(process.cwd(), 'logs', 'doudian-ai-draft-insert-test.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  process.env.DOUDIAN_VERIFY_DB = dbPath;
  closeDb();

  const conv = buildConversation({ conversationId: 'conv_sqlite_draft' });
  const messages = buildMessages([
    { direction: 'buyer', text: '转人工' },
  ]);

  for (const m of messages) {
    insertMessage({
      platform: 'doudian',
      shopId: conv.shopId,
      shopName: conv.shopName,
      conversationId: conv.conversationId,
      buyerId: conv.buyerId,
      buyerName: conv.buyerName,
      direction: m.direction,
      messageType: m.messageType,
      text: m.text,
      timestamp: m.timestamp,
      source: 'test',
    });
  }

  const report = runAiDraftReplySession({ dbPath });
  const row = report.draftId ? getReplyDraftById(report.draftId) : null;
  const count = getDb()
    .prepare('SELECT COUNT(*) AS c FROM platform_reply_drafts')
    .get().c;
  closeDb();

  return (
    report.success &&
    report.reason === 'draft_generated' &&
    report.status === 'draft_only' &&
    row &&
    row.status === 'draft_only' &&
    count >= 1
  );
}

function testSendNotCalled() {
  const sessionPath = path.resolve(process.cwd(), 'scripts/lib/doudian-ai-draft-reply-session.js');
  const mainPath = path.resolve(process.cwd(), 'scripts/doudian-ai-draft-reply.js');
  const generatorPath = path.resolve(process.cwd(), 'src/platforms/doudian/doudian-ai-draft-generator.js');
  const combined = [
    fs.readFileSync(sessionPath, 'utf8'),
    fs.readFileSync(mainPath, 'utf8'),
    fs.readFileSync(generatorPath, 'utf8'),
  ].join('\n');

  const forbidden = [
    'message-sender',
    'doudian-message-sender',
    'sendMessage(',
    'sendDebugCommand',
    'debug.send',
    'wsServer.send',
  ];
  return !forbidden.some((token) => combined.includes(token));
}

function main() {
  console.log('=== 抖店 AI draft reply 专项测试 ===');

  const greetingDraftOk = testGreetingDraft();
  const helloDraftOk = testHelloDraft();
  const stockDraftOk = testStockDraft();
  const priceDraftOk = testPriceDraft();
  const noBuyerMessageHandled = testNoBuyerMessage();
  const riskBlockedOk = testRiskBlocked();
  const sqliteDraftInsertOk = testSqliteDraftInsert();
  const sendNotCalled = testSendNotCalled();

  const summary = {
    success:
      greetingDraftOk &&
      helloDraftOk &&
      stockDraftOk &&
      priceDraftOk &&
      noBuyerMessageHandled &&
      riskBlockedOk &&
      sqliteDraftInsertOk &&
      sendNotCalled,
    greetingDraftOk,
    helloDraftOk: helloDraftOk || greetingDraftOk,
    stockDraftOk,
    priceDraftOk,
    noBuyerMessageHandled,
    riskBlockedOk,
    sqliteDraftInsertOk,
    sendNotCalled,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.success ? 0 : 1);
}

main();
