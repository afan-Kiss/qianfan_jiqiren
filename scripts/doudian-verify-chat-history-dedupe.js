#!/usr/bin/env node
/**
 * 聊天历史去重验证
 * npm run doudian:verify-chat-history:dedupe
 */
const path = require('path');
const fs = require('fs');
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
const { toHistoryPlatformMessage } = require('../src/platforms/doudian/doudian-chat-history-utils');
const { buildFallbackConversationId } = require('../src/platforms/doudian/doudian-conversation-resolver');
const { resolveDirectionFromBubble, DIRECTION_CONFIDENCE_THRESHOLD } = require('../src/platforms/doudian/doudian-direction-resolver');

function buildMockMessages() {
  const shopInfo = { shopId: '263636465', shopName: 'XY祥钰珠宝' };
  const buyerId = 'buyer_dedupe_***';
  const conversationId = buildFallbackConversationId(shopInfo.shopId, buyerId);
  const bubbles = [
    { text: '在在在', rect: { x: 360, y: 220, width: 120, height: 36 }, directionGuess: 'unknown' },
    { text: '转人工', rect: { x: 380, y: 280, width: 100, height: 32 }, directionGuess: 'unknown' },
    {
      text: '您好，现在是人工客服为您服务',
      rect: { x: 620, y: 340, width: 260, height: 40 },
      directionGuess: 'unknown',
    },
    { text: '你好', rect: { x: 370, y: 400, width: 80, height: 30 }, directionGuess: 'unknown' },
    {
      text: '亲亲，很高兴为您服务，请问有什么可以帮您？',
      rect: { x: 640, y: 460, width: 280, height: 42 },
      directionGuess: 'unknown',
    },
    { text: '5555', rect: { x: 365, y: 520, width: 90, height: 28 }, directionGuess: 'unknown' },
    { text: '你还敢', rect: { x: 375, y: 580, width: 100, height: 30 }, directionGuess: 'unknown' },
    {
      text: '在的，请问需要什么帮助',
      rect: { x: 650, y: 640, width: 220, height: 36 },
      directionGuess: 'unknown',
    },
    { text: '这款手镯还有货吗', rect: { x: 390, y: 700, width: 180, height: 34 }, directionGuess: 'unknown' },
    { text: '计算价格', rect: { x: 660, y: 760, width: 120, height: 30 }, directionGuess: 'unknown' },
  ];

  const messageAreaCenterX = 520;
  return bubbles.map((bubble, idx) => {
    const dir = resolveDirectionFromBubble(
      { ...bubble, messageAreaCenterX, bubbleTrusted: true },
      { messageAreaCenterX, bubbleTrusted: true, messageAreaTrusted: true }
    );
    return toHistoryPlatformMessage(
      {
        messageId: `msg_dedupe_${idx + 1}`,
        direction: dir.direction,
        directionConfidence: dir.directionConfidence,
        directionReasons: dir.directionReasons,
        text: bubble.text,
        timestamp: Date.now() - idx * 1000,
        domArea: 'chatBubbleArea',
        bubbleTrusted: true,
        messageAreaTrusted: true,
      },
      shopInfo,
      {
        source: 'dom',
        conversationId,
        buyerId,
        conversationIdSource: 'fallback_buyerId',
      }
    );
  });
}

function main() {
  const knownShops = getDoudianConfig().knownShops || [];
  const knownShopIds = getKnownShopIds(knownShops);
  const dbPath = path.join(process.cwd(), 'logs', 'doudian-chat-history-dedupe.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  process.env.DOUDIAN_VERIFY_DB = dbPath;
  closeDb();

  const messages = buildMockMessages();
  const context = {
    activeShopId: '263636465',
    activeShopName: 'XY祥钰珠宝',
    knownShops,
    knownShopIds,
    conversationId: messages[0].conversationId,
    buyerId: messages[0].buyerId,
    messageAreaTrusted: true,
    bubbleTrusted: true,
  };

  const dedupe = new DoudianDedupe();
  let firstInserted = 0;
  let secondInserted = 0;
  let secondDedupeHit = 0;

  for (const msg of messages) {
    const validation = validateDoudianMessageBeforeInsert(msg, context);
    if (!validation.ok) {
      console.error('validation failed:', msg.text, validation.rejectReason);
      process.exit(1);
    }
    if (!dedupe.isDuplicate(msg)) {
      insertMessage(msg);
      firstInserted += 1;
    }
  }

  for (const msg of messages) {
    if (dedupe.isDuplicate(msg)) {
      secondDedupeHit += 1;
    } else {
      insertMessage(msg);
      secondInserted += 1;
    }
  }

  const db = getDb();
  const rowCount = db.prepare('SELECT COUNT(*) AS c FROM platform_messages').get().c;
  closeDb();

  const summary = {
    success:
      firstInserted === 10 &&
      secondInserted === 0 &&
      secondDedupeHit === 10 &&
      rowCount === 10,
    firstInserted,
    secondInserted,
    secondDedupeHit,
    noDuplicateRows: rowCount === firstInserted,
    directionConfidenceThreshold: DIRECTION_CONFIDENCE_THRESHOLD,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.success ? 0 : 1);
}

main();
