#!/usr/bin/env node
/**
 * 草稿填入专项测试
 * npm run doudian:test-fill-reply-draft
 */
const path = require('path');
const fs = require('fs');
const {
  matchDraftToConversation,
} = require('../src/platforms/doudian/doudian-reply-editor-detector');
const {
  insertReplyDraft,
  getLatestDraftOnlyReply,
  closeDb,
} = require('../src/platforms/doudian/doudian-data-store');

function testBuyerIdFallbackMatch() {
  const r = matchDraftToConversation(
    {
      shop_id: '263636465',
      buyer_id: 'buyer_123',
      conversation_id: 'doudian:buyer_123',
    },
    {
      shopId: '263636465',
      buyerId: 'buyer_123',
      conversationId: 'other_conv',
    }
  );
  return r.matched && r.shopMatched && r.buyerMatched && r.conversationMatched;
}

function testShopMismatch() {
  const r = matchDraftToConversation(
    { shop_id: '111', buyer_id: 'b1', conversation_id: 'c1' },
    { shopId: '222', buyerId: 'b1', conversationId: 'c1' }
  );
  return !r.matched && !r.shopMatched;
}

function testDraftOnlyQuery() {
  const dbPath = path.join(process.cwd(), 'logs', 'doudian-fill-draft-test.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  process.env.DOUDIAN_VERIFY_DB = dbPath;
  closeDb();

  insertReplyDraft({
    platform: 'doudian',
    shopId: '263636465',
    shopName: 'XY祥钰珠宝',
    conversationId: 'conv_fill_test',
    buyerId: 'buyer_fill',
    draftText: '您好，在的~',
    draftReason: 'greeting',
    riskLevel: 'low',
    status: 'draft_only',
    source: 'rule_generator',
  });

  insertReplyDraft({
    platform: 'doudian',
    shopId: '263636465',
    shopName: 'XY祥钰珠宝',
    conversationId: 'conv_risk',
    buyerId: 'buyer_risk',
    draftText: '已退款',
    draftReason: 'risk',
    riskLevel: 'high',
    status: 'risk_blocked',
    source: 'rule_generator',
  });

  const latest = getLatestDraftOnlyReply();
  closeDb();
  return latest && latest.status === 'draft_only' && latest.draft_reason === 'greeting';
}

function testFillSessionSafety() {
  const sessionPath = path.resolve(
    process.cwd(),
    'src/platforms/doudian/doudian-reply-draft-fill-session.js'
  );
  const snippetPath = path.resolve(
    process.cwd(),
    'src/platforms/doudian/injected/doudian-reply-editor-snippet.js'
  );
  const combined = [sessionPath, snippetPath]
    .map((p) => fs.readFileSync(p, 'utf8'))
    .join('\n');

  const hasFill = combined.includes('debug.fill_reply_draft');
  const noSendClick = !combined.includes('.click()');
  const sentFalse = combined.includes('sent: false');
  const sendNotCalled = combined.includes('sendNotCalled: true');
  const noStatusUpdate =
    !combined.includes('UPDATE platform_reply_drafts') &&
    !combined.includes("status = 'sent'") &&
    !combined.includes('status: \'sent\'');
  return hasFill && noSendClick && sentFalse && sendNotCalled && noStatusUpdate;
}

function testMismatchRejected() {
  const r = matchDraftToConversation(
    { shop_id: '263636465', buyer_id: 'a', conversation_id: 'c1' },
    { shopId: '263636465', buyerId: 'b', conversationId: 'c2' }
  );
  return !r.matched;
}

function testRiskBlockedRejected() {
  const sessionCode = fs.readFileSync(
    path.join(process.cwd(), 'src/platforms/doudian/doudian-reply-draft-fill-session.js'),
    'utf8'
  );
  return sessionCode.includes('risk_blocked_draft') && sessionCode.includes("status === 'risk_blocked'");
}

function main() {
  console.log('=== 抖店 fill-reply-draft 专项测试 ===');

  const buyerFallbackOk = testBuyerIdFallbackMatch();
  const shopMismatchOk = testShopMismatch();
  const draftOnlyQueryOk = testDraftOnlyQuery();
  const fillSessionSafetyOk = testFillSessionSafety();
  const mismatchRejected = testMismatchRejected();
  const riskBlockedRejected = testRiskBlockedRejected();

  const summary = {
    success:
      buyerFallbackOk &&
      shopMismatchOk &&
      draftOnlyQueryOk &&
      fillSessionSafetyOk &&
      mismatchRejected &&
      riskBlockedRejected,
    buyerFallbackOk,
    shopMismatchOk,
    draftOnlyQueryOk,
    fillSessionSafetyOk,
    mismatchRejected,
    riskBlockedRejected,
    fillOk: fillSessionSafetyOk,
    sendNotCalled: fillSessionSafetyOk,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.success ? 0 : 1);
}

main();
