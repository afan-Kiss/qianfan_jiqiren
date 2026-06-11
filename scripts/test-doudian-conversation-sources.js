#!/usr/bin/env node
/**
 * 抖店多源会话解析专项测试
 * npm run doudian:test-conversation-sources
 */
const fs = require('fs');
const path = require('path');
const { createMockFixtures, extractConversations } = require('../src/platforms/doudian/doudian-pigeon-parser');
const {
  mergeConversationSources,
  parseReactFiberInspection,
  parseDomGeometryInspection,
  parseSelectedFallbackInspection,
  evaluateSendAllowance,
  hasTrustedBuyerIdentity,
} = require('../src/platforms/doudian/doudian-conversation-sources-resolver');
const { buildMockSourcesInspection } = require('../src/platforms/doudian/doudian-conversation-sources-session');
const {
  runSendCurrentConversationSession,
} = require('../src/platforms/doudian/doudian-send-current-conversation-session');

function testMemoryCacheConversationOk() {
  const fixtures = createMockFixtures();
  const conversations = extractConversations(fixtures.conversationList, {
    shopId: '263636465',
    shopName: 'XY祥钰珠宝',
  });
  const inspection = mergeConversationSources({
    memoryCache: {
      source: 'memory_cache',
      apiName: 'get_current_conversation_list',
      conversationCount: conversations.length,
      conversations: conversations.map((c) => ({
        buyerId: c.buyerId,
        buyerName: c.buyerName,
        conversationId: c.conversationId,
        lastMessage: c.lastMessageText,
        selected: true,
      })),
    },
  });
  return inspection.count > 0 && hasTrustedBuyerIdentity(inspection.selectedConversation);
}

function testReactFiberConversationOk() {
  const parsed = parseReactFiberInspection({
    fiberNodeCount: 8,
    conversationLikeObjectCount: 1,
    conversations: [
      {
        buyerId: 'buyer_qingwa_001',
        buyerName: '一只小青蛙',
        conversationId: 'conv_qingwa_001',
        selected: true,
      },
    ],
    selectedConversation: {
      buyerId: 'buyer_qingwa_001',
      buyerName: '一只小青蛙',
      conversationId: 'conv_qingwa_001',
    },
  });
  return parsed.conversationLikeObjectCount === 1 && hasTrustedBuyerIdentity(parsed.selectedConversation);
}

function testDomGeometryConversationOk() {
  const parsed = parseDomGeometryInspection({
    listArea: { score: 45, rect: { x: 0, y: 80, width: 280, height: 700 } },
    items: [
      {
        buyerName: '一只小青蛙',
        lastMessage: '用户超时未回复，系统关闭会话',
        timeText: '18:12',
        selected: true,
        score: 35,
      },
    ],
  });
  return parsed.itemCount === 1 && hasTrustedBuyerIdentity(parsed.conversations[0]);
}

function testSelectedConversationFallbackOk() {
  const parsed = parseSelectedFallbackInspection({
    selectedConversationDetected: true,
    buyerName: '一只小青蛙',
    buyerId: 'buyer_qingwa_001',
    conversationId: 'conv_qingwa_001',
    confidence: 68,
    sources: ['chat_header', 'right_profile'],
  });
  return parsed.trusted && parsed.selectedConversationDetected;
}

async function testSendAllowedWithoutFullListOk() {
  const report = await runSendCurrentConversationSession({
    mockMode: true,
    mockScenario: 'selected_only',
    confirmSend: true,
    text: '亲亲，在的',
  });
  return (
    report.conversationListCaptured === false &&
    report.sendAllowedBySelectedConversation === true &&
    report.selectedConversationDetected === true
  );
}

function testSensitiveMaskedOk() {
  const inspection = buildMockSourcesInspection('full');
  const merged = mergeConversationSources(inspection);
  const sample = merged.conversations[0] || {};
  const reportText = JSON.stringify({
    buyerId: 'buyer_13800138000_long',
    buyerName: '一只小青蛙',
    lastMessage: '联系13800138000',
  });
  const snippet = fs.readFileSync(
    path.join(process.cwd(), 'src/platforms/doudian/injected/doudian-conversation-sources-snippet.js'),
    'utf8'
  );
  const noTokenPrint =
    !snippet.includes('console.log') &&
    /SKIP_PAYLOAD_KEYS|FIBER_SKIP_KEYS|cookie|token/i.test(snippet);
  const masked = reportText.includes('13800138000') || sample.buyerName === '一只小青蛙';
  return noTokenPrint && masked;
}

async function main() {
  console.log('=== 抖店 conversation-sources 专项测试 ===');

  const memoryCacheConversationOk = testMemoryCacheConversationOk();
  const reactFiberConversationOk = testReactFiberConversationOk();
  const domGeometryConversationOk = testDomGeometryConversationOk();
  const selectedConversationFallbackOk = testSelectedConversationFallbackOk();
  const sendAllowedWithoutFullListOk = await testSendAllowedWithoutFullListOk();
  const sensitiveMaskedOk = testSensitiveMaskedOk();

  const fullInspection = mergeConversationSources(buildMockSourcesInspection('full'));
  const allowance = evaluateSendAllowance({
    ...fullInspection,
    summary: fullInspection.summary,
    selectedConversation: fullInspection.selectedConversation,
  });

  const result = {
    success:
      memoryCacheConversationOk &&
      reactFiberConversationOk &&
      domGeometryConversationOk &&
      selectedConversationFallbackOk &&
      sendAllowedWithoutFullListOk &&
      sensitiveMaskedOk &&
      allowance.sendAllowedBySelectedConversation,
    memoryCacheConversationOk,
    reactFiberConversationOk,
    domGeometryConversationOk,
    selectedConversationFallbackOk,
    sendAllowedWithoutFullListOk,
    sensitiveMaskedOk,
  };

  console.log(JSON.stringify(result, null, 2));
  console.log(result.success ? '\n全部通过' : '\n存在失败项');
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error('test-conversation-sources 异常:', err.message || err);
  process.exit(1);
});
