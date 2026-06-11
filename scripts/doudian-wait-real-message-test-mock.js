#!/usr/bin/env node
/**
 * mock 注入测试 wait-real-message 入库链路
 * npm run doudian:wait-real-message:test-mock
 */
const path = require('path');
const {
  runWaitRealMessageSession,
  buildWaitTextReport,
} = require('./lib/doudian-wait-real-message-session');
const { writeReports } = require('./lib/auto-verify-utils');

async function main() {
  console.log('=== 抖店 wait-real-message mock 链路测试 ===');

  const report = await runWaitRealMessageSession({
    mockMode: true,
    dbPath: path.join(process.cwd(), 'logs', 'doudian-wait-real-message-mock.db'),
    mockMessage: {
      conversationId: 'conv_mock_wait_001',
      buyerId: 'buyer_***88',
      buyerName: '测试买家',
      messageId: 'msg_mock_wait_001',
      text: '你好，这是一条脱敏模拟买家消息',
      direction: 'buyer',
      messageType: 'text',
      timestamp: Date.now(),
    },
    mockShopInfo: {
      shopId: '263636465',
      shopName: 'XY祥钰珠宝',
    },
  });

  const paths = writeReports(report, {
    prefix: 'doudian-wait-real-message-mock',
    buildTextReport: buildWaitTextReport,
  });

  console.log(JSON.stringify(report, null, 2));
  console.log(`\nJSON: ${paths.jsonLatest}`);

  process.exit(report.success ? 0 : 1);
}

main().catch((err) => {
  console.error('mock 测试异常:', err.message || err);
  process.exit(1);
});
