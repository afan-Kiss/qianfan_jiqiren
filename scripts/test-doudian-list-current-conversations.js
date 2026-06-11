#!/usr/bin/env node
/**
 * 抖店 list-current-conversations 专项测试
 * npm run doudian:test-list-current-conversations
 */
const fs = require('fs');
const path = require('path');
const {
  runConversationListSession,
  buildMockListPayload,
  applyListPayloadToReport,
} = require('../src/platforms/doudian/doudian-conversation-list-session');
const {
  parseConversationListPayload,
  formatConversationListTerminal,
} = require('../src/platforms/doudian/doudian-conversation-list-parser');

function testSnippetNoClick() {
  const snippetPath = path.join(
    process.cwd(),
    'src/platforms/doudian/injected/doudian-conversation-list-snippet.js'
  );
  const sessionPath = path.join(
    process.cwd(),
    'src/platforms/doudian/doudian-conversation-list-session.js'
  );
  const combined = [snippetPath, sessionPath].map((p) => fs.readFileSync(p, 'utf8')).join('\n');
  return (
    !combined.includes('.click(') &&
    !combined.includes('switch_conversation') &&
    !combined.includes('select_conversation') &&
    !combined.includes('debug.send_message_to_buyer')
  );
}

async function testMockListRead() {
  const report = await runConversationListSession({ mockMode: true, mockScenario: 'success' });
  return report.success && report.count === 2 && report.conversations.length === 2;
}

async function testSelectedDetected() {
  const report = await runConversationListSession({ mockMode: true, mockScenario: 'success' });
  return (
    report.selectedConversationDetected &&
    report.selectedConversation?.buyerName?.includes('一只小青蛙')
  );
}

function testTerminalFormat() {
  const payload = buildMockListPayload('success');
  const report = {};
  applyListPayloadToReport(report, payload);
  const lines = formatConversationListTerminal(report.conversations, report.selectedConversation);
  return (
    lines[0].includes('当前会话列表') &&
    lines.some((l) => l.includes('一只小青蛙') && l.includes('[当前选中]'))
  );
}

function testRedaction() {
  const parsed = parseConversationListPayload({
    conversations: [
      {
        index: 0,
        buyerId: 'buyer_13800138000_long',
        buyerName: '一只小青蛙',
        conversationId: 'conv_13800138000_abc',
        lastMessage: '联系13800138000',
        timeText: '18:12',
        selected: true,
      },
    ],
    selectedConversation: {
      buyerId: 'buyer_13800138000_long',
      buyerName: '一只小青蛙',
      conversationId: 'conv_13800138000_abc',
      selected: true,
    },
  });
  const c = parsed.conversations[0];
  return (
    c.buyerId.includes('***') &&
    !c.buyerId.includes('13800138000') &&
    c.lastMessage.includes('****')
  );
}

async function main() {
  console.log('=== 抖店 list-current-conversations 专项测试 ===');

  const mockListRead = await testMockListRead();
  const selectedDetected = await testSelectedDetected();
  const snippetNoClick = testSnippetNoClick();
  const terminalFormat = testTerminalFormat();
  const redaction = testRedaction();

  const checks = {
    mockListRead,
    selectedDetected,
    snippetNoClick,
    terminalFormat,
    redaction,
  };

  console.log(JSON.stringify(checks, null, 2));
  const allOk = Object.values(checks).every(Boolean);
  console.log(allOk ? '\n全部通过' : '\n存在失败项');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('test-list-current-conversations 异常:', err.message || err);
  process.exit(1);
});
