#!/usr/bin/env node
/**
 * mock 聊天历史校验 + 入库链路测试
 * npm run doudian:verify-chat-history:test-mock
 */
const path = require('path');
const fs = require('fs');
const { getDoudianConfig } = require('../src/shared/config');
const {
  validateDoudianMessageBeforeInsert,
  evaluateConversationSelection,
  getKnownShopIds,
} = require('../src/platforms/doudian/doudian-history-validation');
const {
  insertMessage,
  cleanupBadHistoryRows,
  findBadHistoryRows,
  closeDb,
  getDb,
} = require('../src/platforms/doudian/doudian-data-store');
const {
  runChatHistorySession,
  buildHistoryTextReport,
} = require('./lib/doudian-chat-history-session');
const { writeReports } = require('./lib/auto-verify-utils');
const { DoudianDedupe } = require('../src/platforms/doudian/doudian-dedupe');
const {
  resolveDirectionFromBubble,
  DIRECTION_CONFIDENCE_THRESHOLD,
} = require('../src/platforms/doudian/doudian-direction-resolver');
const {
  buildFallbackConversationId,
} = require('../src/platforms/doudian/doudian-conversation-resolver');
const { toHistoryPlatformMessage } = require('../src/platforms/doudian/doudian-chat-history-utils');

function buildContext() {
  const knownShops = getDoudianConfig().knownShops || [];
  return {
    activeShopId: '263636465',
    activeShopName: 'XY祥钰珠宝',
    knownShops,
    knownShopIds: getKnownShopIds(knownShops),
    conversationId: 'conv_mock_hist_001',
    buyerId: 'buyer_***88',
    buyerName: '测试买家',
    messageAreaTrusted: true,
    bubbleTrusted: true,
  };
}

async function testNormalHistoryPipeline() {
  return runChatHistorySession({
    mockMode: true,
    dbPath: path.join(process.cwd(), 'logs', 'doudian-chat-history-mock.db'),
    mockShopInfo: {
      shopId: '263636465',
      shopName: 'XY祥钰珠宝',
    },
  });
}

function testWrongShopRejected(context) {
  const result = validateDoudianMessageBeforeInsert(
    {
      platform: 'doudian',
      shopId: '213196845',
      shopName: '抖音电商大连自营旗舰店',
      conversationId: context.conversationId,
      buyerId: context.buyerId,
      buyerName: context.buyerName,
      direction: 'buyer',
      text: '你好，在吗',
      source: 'dom',
      domArea: 'chatBubbleArea',
    },
    context
  );
  return !result.ok && result.rejectReason === 'shop_id_not_in_known_shops';
}

function testUiBuyerNameRejected() {
  const result = evaluateConversationSelection({ buyerName: '个人短语' });
  return result.uiNoiseBuyerNameDetected && !result.selectedConversationDetected;
}

function testUnknownDirectionRejected(context) {
  const result = validateDoudianMessageBeforeInsert(
    {
      platform: 'doudian',
      shopId: context.activeShopId,
      shopName: context.activeShopName,
      conversationId: '',
      buyerId: '',
      buyerName: '',
      direction: 'unknown',
      text: '你好，在吗',
      source: 'dom',
      domArea: 'chatBubbleArea',
    },
    context
  );
  return !result.ok && result.rejectReason === 'missing_conversation_identity';
}

function testSidePanelRejected(context) {
  const result = validateDoudianMessageBeforeInsert(
    {
      platform: 'doudian',
      shopId: context.activeShopId,
      shopName: context.activeShopName,
      conversationId: context.conversationId,
      buyerId: context.buyerId,
      buyerName: context.buyerName,
      direction: 'buyer',
      text: '抖音-商品详情页',
      source: 'dom',
      domArea: 'orderCardArea',
    },
    context
  );
  return !result.ok && result.rejectReason === 'side_panel_dom_candidate';
}

function testActiveShopMismatchRejected(context) {
  const result = validateDoudianMessageBeforeInsert(
    {
      platform: 'doudian',
      shopId: '213196845',
      shopName: '抖音电商大连自营旗舰店',
      conversationId: context.conversationId,
      buyerId: context.buyerId,
      buyerName: context.buyerName,
      direction: 'buyer',
      text: '这款手镯还有货吗',
      source: 'dom',
      domArea: 'chatBubbleArea',
    },
    context
  );
  return !result.ok;
}

function testBadHistoryCleanup() {
  const dbPath = path.join(process.cwd(), 'logs', 'doudian-chat-history-cleanup-mock.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  process.env.DOUDIAN_VERIFY_DB = dbPath;
  closeDb();

  insertMessage({
    platform: 'doudian',
    shopId: '213196845',
    shopName: '抖音电商大连自营旗舰店',
    conversationId: '',
    buyerId: '',
    buyerName: '个人短语',
    direction: 'unknown',
    messageType: 'text',
    text: '拖拽到此发送给 xxx',
    source: 'dom',
    timestamp: Date.now(),
  });
  insertMessage({
    platform: 'doudian',
    shopId: '213196845',
    shopName: '抖音电商大连自营旗舰店',
    conversationId: '',
    direction: 'unknown',
    text: '添加备注',
    source: 'dom',
    timestamp: Date.now(),
  });

  const before = findBadHistoryRows({ shopId: '213196845' }).length;
  const cleanup = cleanupBadHistoryRows({ shopId: '213196845' });
  const after = findBadHistoryRows({ shopId: '213196845' }).length;
  closeDb();
  return before === 2 && cleanup.badRowsFound === 2 && cleanup.badRowsDeleted === 2 && after === 0;
}

function testLeftBubbleBuyerOk() {
  const dir = resolveDirectionFromBubble(
    {
      text: '在在在',
      rect: { x: 360, y: 220, width: 120, height: 36 },
      bubbleCenterX: 420,
      messageAreaCenterX: 520,
      isLeftBubble: true,
    },
    { messageAreaCenterX: 520 }
  );
  return dir.directionGuess === 'buyer' && dir.directionConfidence >= DIRECTION_CONFIDENCE_THRESHOLD;
}

function testRightBubbleSellerOk() {
  const dir = resolveDirectionFromBubble(
    {
      text: '在的，请问需要什么帮助',
      rect: { x: 620, y: 280, width: 220, height: 40 },
      bubbleCenterX: 730,
      messageAreaCenterX: 520,
      isRightBubble: true,
    },
    { messageAreaCenterX: 520 }
  );
  return dir.directionGuess === 'seller' && dir.directionConfidence >= DIRECTION_CONFIDENCE_THRESHOLD;
}

function testSellerPhraseOk() {
  const dir = resolveDirectionFromBubble({
    text: '亲亲，很高兴为您服务，请问有什么可以帮您？',
    rect: { x: 500, y: 300, width: 260, height: 40 },
    bubbleCenterX: 630,
    messageAreaCenterX: 520,
  });
  return dir.directionGuess === 'seller' && dir.directionConfidence >= DIRECTION_CONFIDENCE_THRESHOLD;
}

function testBuyerPhraseOk() {
  const dir = resolveDirectionFromBubble({
    text: '转人工',
    rect: { x: 360, y: 240, width: 100, height: 30 },
    bubbleCenterX: 410,
    messageAreaCenterX: 520,
    isLeftBubble: true,
  });
  return dir.directionGuess === 'buyer' && dir.directionConfidence >= DIRECTION_CONFIDENCE_THRESHOLD;
}

function testFallbackConversationIdOk(context) {
  const fallback = buildFallbackConversationId(context.activeShopId, context.buyerId);
  const msg = toHistoryPlatformMessage(
    {
      text: '你好',
      direction: 'buyer',
      directionConfidence: 75,
      domArea: 'chatBubbleArea',
      bubbleTrusted: true,
      messageAreaTrusted: true,
    },
    { shopId: context.activeShopId, shopName: context.activeShopName },
    {
      conversationId: fallback,
      buyerId: context.buyerId,
      conversationIdSource: 'fallback_buyerId',
      source: 'dom',
    }
  );
  const validation = validateDoudianMessageBeforeInsert(msg, {
    ...context,
    conversationId: fallback,
    conversationIdSource: 'fallback_buyerId',
  });
  return fallback === `doudian:${context.activeShopId}:buyer:${context.buyerId}` && validation.ok;
}

function testHistoryDedupeOk(context) {
  const dbPath = path.join(process.cwd(), 'logs', 'doudian-chat-history-mock-dedupe.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  process.env.DOUDIAN_VERIFY_DB = dbPath;
  closeDb();

  const dedupe = new DoudianDedupe();
  const msg = toHistoryPlatformMessage(
    {
      messageId: 'msg_hist_dedupe_001',
      text: '你好，在吗',
      direction: 'buyer',
      directionConfidence: 80,
      timestamp: Date.now(),
      domArea: 'chatBubbleArea',
    },
    { shopId: context.activeShopId, shopName: context.activeShopName },
    {
      conversationId: context.conversationId,
      buyerId: context.buyerId,
      source: 'dom',
    }
  );

  let firstInserted = 0;
  let secondInserted = 0;
  let secondDedupeHit = 0;

  if (!dedupe.isDuplicate(msg)) {
    insertMessage(msg);
    firstInserted += 1;
  }
  if (dedupe.isDuplicate(msg)) secondDedupeHit += 1;
  else {
    insertMessage(msg);
    secondInserted += 1;
  }

  const rowCount = getDb().prepare('SELECT COUNT(*) AS c FROM platform_messages').get().c;
  closeDb();
  return firstInserted === 1 && secondInserted === 0 && secondDedupeHit === 1 && rowCount === 1;
}

async function main() {
  console.log('=== 抖店 verify-chat-history mock 校验测试 ===');
  const context = buildContext();

  const normalReport = await testNormalHistoryPipeline();
  const normalHistoryInsertOk =
    normalReport.success &&
    normalReport.reason === 'mock_chat_history_pipeline_ok' &&
    normalReport.insertedMessageCount === 3 &&
    normalReport.validatedMessageCount === 3 &&
    (normalReport.directionStats?.buyer || 0) + (normalReport.directionStats?.seller || 0) > 0;

  const wrongShopRejected = testWrongShopRejected(context);
  const uiBuyerNameRejected = testUiBuyerNameRejected();
  const unknownDirectionRejected = testUnknownDirectionRejected(context);
  const sidePanelRejected = testSidePanelRejected(context);
  const activeShopMismatchRejected = testActiveShopMismatchRejected(context);
  const badHistoryCleanupOk = testBadHistoryCleanup();
  const leftBubbleBuyerOk = testLeftBubbleBuyerOk();
  const rightBubbleSellerOk = testRightBubbleSellerOk();
  const sellerPhraseOk = testSellerPhraseOk();
  const buyerPhraseOk = testBuyerPhraseOk();
  const fallbackConversationIdOk = testFallbackConversationIdOk(context);
  const historyDedupeOk = testHistoryDedupeOk(context);

  const summary = {
    success:
      normalHistoryInsertOk &&
      wrongShopRejected &&
      uiBuyerNameRejected &&
      unknownDirectionRejected &&
      sidePanelRejected &&
      activeShopMismatchRejected &&
      badHistoryCleanupOk &&
      leftBubbleBuyerOk &&
      rightBubbleSellerOk &&
      sellerPhraseOk &&
      buyerPhraseOk &&
      fallbackConversationIdOk &&
      historyDedupeOk,
    normalHistoryInsertOk,
    wrongShopRejected,
    uiBuyerNameRejected,
    unknownDirectionRejected,
    sidePanelRejected,
    activeShopMismatchRejected,
    badHistoryCleanupOk,
    leftBubbleBuyerOk,
    rightBubbleSellerOk,
    sellerPhraseOk,
    buyerPhraseOk,
    fallbackConversationIdOk,
    historyDedupeOk,
    insertedMessageCount: normalReport.insertedMessageCount,
    validatedMessageCount: normalReport.validatedMessageCount,
    directionStats: normalReport.directionStats,
  };

  writeReports(
    { ...normalReport, mockValidationSummary: summary },
    {
      prefix: 'doudian-chat-history-mock',
      buildTextReport: buildHistoryTextReport,
    }
  );

  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.success ? 0 : 1);
}

main().catch((err) => {
  console.error('mock 测试异常:', err.message || err);
  process.exit(1);
});
