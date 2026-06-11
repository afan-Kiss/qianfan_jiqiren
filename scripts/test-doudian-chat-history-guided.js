#!/usr/bin/env node
/**
 * 引导式聊天历史验证专项测试
 * npm run doudian:test-chat-history-guided
 */
const path = require('path');
const { getDoudianConfig } = require('../src/shared/config');
const { DoudianDedupe } = require('../src/platforms/doudian/doudian-dedupe');
const {
  validateDoudianMessageBeforeInsert,
  getKnownShopIds,
} = require('../src/platforms/doudian/doudian-history-validation');
const {
  insertMessage,
  closeDb,
  getDb,
} = require('../src/platforms/doudian/doudian-data-store');
const { runChatHistorySession } = require('./lib/doudian-chat-history-session');
const {
  buildFallbackConversationId,
  isConversationSelected,
} = require('../src/platforms/doudian/doudian-conversation-resolver');
const { resolveDirectionFromBubble } = require('../src/platforms/doudian/doudian-direction-resolver');
const { toHistoryPlatformMessage } = require('../src/platforms/doudian/doudian-chat-history-utils');

async function testGuidedMockFlow() {
  const report = await runChatHistorySession({
    mockMode: true,
    mockGuidedMode: true,
    guidedMode: true,
    dbPath: path.join(process.cwd(), 'logs', 'doudian-chat-history-guided-mock.db'),
    mockShopInfo: {
      shopId: '263636465',
      shopName: 'XY祥钰珠宝',
    },
  });
  const summary = report.mockGuidedSummary || {};
  return {
    waitsWhenNoConversation:
      summary.beforeSelectionInserted === 0 && summary.beforeSelectionCandidates > 0,
    startsAfterConversationSelected:
      report.selectedConversationDetected &&
      report.insertedMessageCount > 0 &&
      summary.afterSelectionInserted > 0,
    fallbackConversationIdOk:
      report.fallbackConversationIdUsed &&
      report.conversationIdSource === 'fallback_buyerId',
    directionResolvedOk:
      (report.directionStats?.buyer || 0) + (report.directionStats?.seller || 0) > 0,
    dedupeOk: report.dedupeHitCount > 0 && report.insertedMessageCount >= 1,
    report,
  };
}

function testNoInsertWithoutIdentity() {
  const knownShops = getDoudianConfig().knownShops || [];
  const context = {
    activeShopId: '263636465',
    knownShopIds: getKnownShopIds(knownShops),
    knownShops,
  };
  const msg = toHistoryPlatformMessage(
    {
      text: '在在在',
      direction: 'buyer',
      directionConfidence: 75,
      domArea: 'chatBubbleArea',
      bubbleTrusted: true,
      messageAreaTrusted: true,
    },
    { shopId: '263636465', shopName: 'XY祥钰珠宝' },
    { source: 'dom' }
  );
  const validation = validateDoudianMessageBeforeInsert(msg, context);
  return !validation.ok && validation.rejectReason === 'missing_conversation_identity';
}

function testFallbackAndDirection() {
  const shopId = '263636465';
  const buyerId = 'buyer_guided_test';
  const fallback = buildFallbackConversationId(shopId, buyerId);
  const dir = resolveDirectionFromBubble(
    {
      text: '转人工',
      bubbleCenterX: 400,
      messageAreaCenterX: 520,
    },
    { messageAreaCenterX: 520 }
  );
  return (
    fallback === `doudian:${shopId}:buyer:${buyerId}` &&
    dir.direction === 'buyer' &&
    isConversationSelected({ buyerId, conversationId: fallback, selectedConversationDetected: true })
  );
}

function testDedupeLoop() {
  const dbPath = path.join(process.cwd(), 'logs', 'doudian-chat-history-guided-dedupe.db');
  const fs = require('fs');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  process.env.DOUDIAN_VERIFY_DB = dbPath;
  closeDb();

  const dedupe = new DoudianDedupe();
  const shopInfo = { shopId: '263636465', shopName: 'XY祥钰珠宝' };
  const buyerId = 'buyer_dedupe_guided';
  const conversationId = buildFallbackConversationId(shopInfo.shopId, buyerId);
  const msg = toHistoryPlatformMessage(
    {
      messageId: 'msg_guided_dedupe_1',
      text: '你好',
      direction: 'buyer',
      directionConfidence: 80,
      domArea: 'chatBubbleArea',
    },
    shopInfo,
    { conversationId, buyerId, source: 'dom' }
  );

  let secondDedupeHit = 0;
  if (!dedupe.isDuplicate(msg)) insertMessage(msg);
  if (dedupe.isDuplicate(msg)) secondDedupeHit += 1;

  const rowCount = getDb().prepare('SELECT COUNT(*) AS c FROM platform_messages').get().c;
  closeDb();
  return secondDedupeHit === 1 && rowCount === 1;
}

async function main() {
  console.log('=== 抖店 guided history 专项测试 ===');
  const guided = await testGuidedMockFlow();
  const noInsertWithoutIdentity = testNoInsertWithoutIdentity();
  const fallbackAndDirection = testFallbackAndDirection();
  const dedupeOk = testDedupeLoop();

  const summary = {
    success:
      guided.waitsWhenNoConversation &&
      guided.startsAfterConversationSelected &&
      guided.fallbackConversationIdOk &&
      guided.directionResolvedOk &&
      guided.dedupeOk &&
      noInsertWithoutIdentity &&
      fallbackAndDirection &&
      dedupeOk,
    waitsWhenNoConversation: guided.waitsWhenNoConversation && noInsertWithoutIdentity,
    startsAfterConversationSelected: guided.startsAfterConversationSelected,
    fallbackConversationIdOk: guided.fallbackConversationIdOk && fallbackAndDirection,
    directionResolvedOk: guided.directionResolvedOk,
    dedupeOk: guided.dedupeOk && dedupeOk,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.success ? 0 : 1);
}

main().catch((err) => {
  console.error('guided 测试异常:', err.message || err);
  process.exit(1);
});
