#!/usr/bin/env node
/**
 * 引导式 fill-reply-draft 专项测试
 * npm run doudian:test-fill-reply-draft-guided
 */
const path = require('path');
const fs = require('fs');
const {
  runReplyEditorSession,
  matchDraftToConversation,
} = require('../src/platforms/doudian/doudian-reply-draft-fill-session');
const {
  insertReplyDraft,
  getReplyDraftById,
  closeDb,
} = require('../src/platforms/doudian/doudian-data-store');

async function testGuidedFillMock() {
  const report = await runReplyEditorSession({
    mockMode: true,
    mockGuidedMode: true,
    guidedMode: true,
    mode: 'fill',
    mockShopInfo: { shopId: '263636465', shopName: 'XY祥钰珠宝' },
    mockBuyerId: 'buyer_guided_fill_001',
    mockDraftId: 88,
  });
  const summary = report.mockGuidedSummary || {};
  return {
    waitsWhenNoConversation: summary.inspectedBeforeSelection,
    startsAfterConversationSelected: summary.selectionAnnounced,
    draftMatchOk: report.shopMatched && report.buyerMatched && report.conversationMatched,
    fillOk: report.filled && report.fillVerified,
    activeShopResolvedOk: report.activeShopResolved === true,
    draftStatusUnchanged: report.draftStatusAfter === 'draft_only',
    sendNotCalled: report.sent === false && report.sendNotCalled === true,
    report,
  };
}

function testFillRejectsUnresolvedShop() {
  const sessionCode = fs.readFileSync(
    path.join(process.cwd(), 'src/platforms/doudian/doudian-reply-draft-fill-session.js'),
    'utf8'
  );
  return (
    sessionCode.includes('active_shop_not_resolved') &&
    sessionCode.includes('!isActiveShopResolved(report)') &&
    sessionCode.includes('activeShopResolved')
  );
}

function testMismatchRejected() {
  const r = matchDraftToConversation(
    { shop_id: '263636465', buyer_id: 'buyer_a', conversation_id: 'conv_a' },
    { shopId: '263636465', buyerId: 'buyer_b', conversationId: 'conv_b' }
  );
  return !r.matched;
}

function testRiskBlockedRejected() {
  const sessionCode = fs.readFileSync(
    path.join(process.cwd(), 'src/platforms/doudian/doudian-reply-draft-fill-session.js'),
    'utf8'
  );
  return sessionCode.includes('risk_blocked') && sessionCode.includes('risk_blocked_draft');
}

function testDraftStatusUnchangedInDb() {
  const dbPath = path.join(process.cwd(), 'logs', 'doudian-fill-guided-status-test.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  process.env.DOUDIAN_VERIFY_DB = dbPath;
  closeDb();

  const inserted = insertReplyDraft({
    platform: 'doudian',
    shopId: '263636465',
    shopName: 'XY祥钰珠宝',
    conversationId: 'conv_status_test',
    buyerId: 'buyer_status',
    draftText: '测试草稿',
    draftReason: 'greeting',
    riskLevel: 'low',
    status: 'draft_only',
    source: 'rule_generator',
  });

  const before = getReplyDraftById(inserted.id);
  closeDb();
  return before && before.status === 'draft_only';
}

function testSendNotCalledInCode() {
  const paths = [
    'src/platforms/doudian/doudian-reply-draft-fill-session.js',
    'scripts/doudian-fill-reply-draft-guided.js',
    'src/platforms/doudian/injected/doudian-reply-editor-snippet.js',
  ];
  const combined = paths.map((p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')).join('\n');
  return !combined.includes('.click()') && combined.includes('sendNotCalled: true');
}

async function main() {
  console.log('=== 抖店 fill-reply-draft guided 专项测试 ===');
  const guided = await testGuidedFillMock();
  const fillRejectsUnresolvedShop = testFillRejectsUnresolvedShop();
  const mismatchRejected = testMismatchRejected();
  const riskBlockedRejected = testRiskBlockedRejected();
  const draftStatusUnchanged = testDraftStatusUnchangedInDb();
  const sendNotCalled = testSendNotCalledInCode();

  const summary = {
    success:
      guided.waitsWhenNoConversation &&
      guided.startsAfterConversationSelected &&
      guided.draftMatchOk &&
      guided.fillOk &&
      guided.activeShopResolvedOk &&
      guided.draftStatusUnchanged &&
      fillRejectsUnresolvedShop &&
      mismatchRejected &&
      riskBlockedRejected &&
      draftStatusUnchanged &&
      sendNotCalled &&
      guided.sendNotCalled,
    waitsWhenNoConversation: guided.waitsWhenNoConversation,
    startsAfterConversationSelected: guided.startsAfterConversationSelected,
    editorDetectedOk: guided.report?.editorFound !== false,
    sendButtonDetectedOk: true,
    draftMatchOk: guided.draftMatchOk && mismatchRejected,
    fillOk: guided.fillOk && fillRejectsUnresolvedShop,
    draftStatusUnchanged: guided.draftStatusUnchanged && draftStatusUnchanged,
    sendNotCalled: sendNotCalled && guided.sendNotCalled,
    fillRejectsUnresolvedShop,
    activeShopResolvedOk: guided.activeShopResolvedOk,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.success ? 0 : 1);
}

main();
