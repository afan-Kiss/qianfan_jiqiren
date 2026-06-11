#!/usr/bin/env node
/**
 * 抖店 send-to-current-conversation guided 专项测试
 * npm run doudian:test-send-to-current-conversation-guided
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  runSendCurrentConversationGuidedSession,
  evaluateSendCurrentGates,
} = require('../src/platforms/doudian/doudian-send-current-conversation-session');
const {
  getLatestOutboundMessage,
  closeDb,
} = require('../src/platforms/doudian/doudian-data-store');

function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doudian-send-guided-test-'));
  const dbPath = path.join(dir, 'test.db');
  process.env.DOUDIAN_VERIFY_DB = dbPath;
  try {
    return fn(dbPath);
  } finally {
    closeDb();
    delete process.env.DOUDIAN_VERIFY_DB;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function testMissingConfirmBlocked() {
  const report = await runSendCurrentConversationGuidedSession({
    mockMode: false,
    confirmSend: false,
    text: '测试',
  });
  return report.reason === 'missing_confirm_send';
}

async function testGuidedWaitsOnEmpty() {
  const report = await runSendCurrentConversationGuidedSession({
    mockMode: true,
    mockScenario: 'guided_empty_wait',
    guidedMode: true,
    confirmSend: true,
    text: '测试',
  });
  return (
    report.success === false &&
    report.emptyStateDetected === true &&
    report.selectedConversationDetected === false &&
    report.mockGuidedSummary?.keptWaitingOnEmpty === true
  );
}

async function testGuidedTimeout() {
  const report = await runSendCurrentConversationGuidedSession({
    mockMode: true,
    mockScenario: 'guided_timeout',
    guidedMode: true,
    confirmSend: true,
    text: '测试',
  });
  return report.reason === 'timeout_no_selected_conversation' && report.sent === false;
}

async function testSelectedOnlySendOk() {
  const report = await runSendCurrentConversationGuidedSession({
    mockMode: true,
    mockScenario: 'selected_only',
    guidedMode: true,
    confirmSend: true,
    text: '亲亲，在的',
  });
  return (
    report.success === true &&
    report.conversationListCaptured === false &&
    report.sendAllowedBySelectedConversation === true &&
    report.filled === true &&
    report.verifiedInChat === true
  );
}

function testNoBatchNoSwitch() {
  const sessionPath = path.join(
    process.cwd(),
    'src/platforms/doudian/doudian-send-current-conversation-session.js'
  );
  const session = fs.readFileSync(sessionPath, 'utf8');
  const sendBlock = session.match(/function trySend[\s\S]*?^  }/m)?.[0] || '';
  return (
    sendBlock.includes('imBridgeIds[0]') &&
    !sendBlock.includes('for (const id of imBridgeIds)') &&
    !session.includes('switch_conversation')
  );
}

function testSqliteOutbound(report) {
  const row = getLatestOutboundMessage();
  return row && row.status === 'sent' && report.outboundMessageId === row.id;
}

async function main() {
  console.log('=== 抖店 send-to-current-conversation guided 专项测试 ===');

  const result = await withTempDb(async () => {
    const missingConfirmBlocked = await testMissingConfirmBlocked();
    const guidedWaitsOnEmpty = await testGuidedWaitsOnEmpty();
    const guidedTimeout = await testGuidedTimeout();
    const selectedOnlySendOk = await testSelectedOnlySendOk();
    const noBatchNoSwitch = testNoBatchNoSwitch();
    const gatesBlockNoBuyer = evaluateSendCurrentGates(
      {
        imBridgeSeen: 1,
        activeShopResolved: true,
        selectedConversationDetected: false,
        editorFound: true,
        editorConfidence: 100,
        sendButtonFound: true,
        sendButtonEnabled: true,
      },
      { confirmSend: true, text: 'hi' }
    ).reason === 'no_selected_conversation';

    const mockReport = await runSendCurrentConversationGuidedSession({
      mockMode: true,
      mockScenario: 'success',
      guidedMode: true,
      confirmSend: true,
      text: '亲亲，在的',
    });
    const sqliteOutboundOk = testSqliteOutbound(mockReport);

    return {
      missingConfirmBlocked,
      guidedWaitsOnEmpty,
      guidedTimeout,
      selectedOnlySendOk,
      mockFillOk: mockReport.filled && mockReport.fillVerified,
      mockSendClickOk: mockReport.sendClicked,
      verifyInChatOk: mockReport.verifiedInChat,
      sqliteOutboundOk,
      noBatchNoSwitch,
      gatesBlockNoBuyer,
    };
  });

  result.success = Object.values(result).every(Boolean);
  console.log(JSON.stringify(result, null, 2));
  console.log(result.success ? '\n全部通过' : '\n存在失败项');
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error('test-send-to-current-conversation-guided 异常:', err.message || err);
  process.exit(1);
});
