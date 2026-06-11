#!/usr/bin/env node
/**
 * 抖店 send-to-current-conversation 专项测试
 * npm run doudian:test-send-to-current-conversation
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  runSendCurrentConversationSession,
  evaluateSendCurrentGates,
  hasBuyerIdentity,
} = require('../src/platforms/doudian/doudian-send-current-conversation-session');
const {
  getLatestOutboundMessage,
  closeDb,
} = require('../src/platforms/doudian/doudian-data-store');

function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doudian-send-current-test-'));
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
  const report = await runSendCurrentConversationSession({
    mockMode: false,
    confirmSend: false,
    text: '测试',
  });
  return report.reason === 'missing_confirm_send' && report.sent === false;
}

async function testNoSelectedBlocked() {
  const report = await runSendCurrentConversationSession({
    mockMode: true,
    mockScenario: 'no_selected',
    confirmSend: true,
    text: '测试',
  });
  return report.reason === 'no_selected_conversation' && report.sent === false;
}

async function testEditorMissingBlocked() {
  const report = await runSendCurrentConversationSession({
    mockMode: true,
    mockScenario: 'editor_missing',
    confirmSend: true,
    text: '测试',
  });
  return report.reason === 'reply_editor_not_found' && report.sent === false;
}

async function testSendButtonMissingBlocked() {
  const report = await runSendCurrentConversationSession({
    mockMode: true,
    mockScenario: 'send_button_missing',
    confirmSend: true,
    text: '测试',
  });
  return report.reason === 'send_button_not_found' && report.sent === false;
}

async function testSelectedOnlySendAllowed() {
  const report = await runSendCurrentConversationSession({
    mockMode: true,
    mockScenario: 'selected_only',
    confirmSend: true,
    text: '亲亲，在的',
  });
  return (
    report.sendAllowedBySelectedConversation === true &&
    report.conversationListCaptured === false &&
    report.filled === true
  );
}

async function testMockSuccess() {
  const report = await runSendCurrentConversationSession({
    mockMode: true,
    mockScenario: 'success',
    confirmSend: true,
    text: '亲亲，在的',
  });
  return {
    mockFillOk: report.filled === true && report.fillVerified === true,
    mockSendClickOk: report.sendClicked === true,
    verifyInChatOk: report.verifiedInChat === true && report.reason === 'message_sent_and_verified',
    report,
  };
}

function testSqliteOutboundOk(report) {
  const row = getLatestOutboundMessage();
  return (
    row &&
    row.status === 'sent' &&
    row.verified_in_chat === 1 &&
    report.outboundMessageId === row.id
  );
}

function testNoBatchNoSwitch() {
  const sessionPath = path.join(
    process.cwd(),
    'src/platforms/doudian/doudian-send-current-conversation-session.js'
  );
  const session = fs.readFileSync(sessionPath, 'utf8');
  const sendBlock = session.match(/function trySend[\s\S]*?^  }/m)?.[0] || '';
  const singleSend =
    sendBlock.includes('debug.send_to_current_conversation') &&
    !sendBlock.includes('for (const id of imBridgeIds)') &&
    sendBlock.includes('imBridgeIds[0]');
  const noSwitch =
    !session.includes('switch_conversation') &&
    !session.includes('select_conversation') &&
    !session.includes('debug.send_message_to_buyer') &&
    !session.includes('targetBuyerName');
  return singleSend && noSwitch;
}

function testGatesRequireBuyerIdentity() {
  const base = {
    imBridgeSeen: 1,
    activeShopResolved: true,
    selectedConversationDetected: true,
    editorFound: true,
    editorConfidence: 100,
    sendButtonFound: true,
    sendButtonEnabled: true,
  };
  const noBuyer = evaluateSendCurrentGates(
    { ...base, buyerId: '', buyerName: '' },
    { confirmSend: true, text: 'hi' }
  );
  const withBuyer = evaluateSendCurrentGates(
    { ...base, buyerName: '一只小青蛙' },
    { confirmSend: true, text: 'hi' }
  );
  return (
    noBuyer.reason === 'no_selected_conversation' &&
    withBuyer.ok &&
    hasBuyerIdentity({ buyerName: '一只小青蛙' })
  );
}

async function main() {
  console.log('=== 抖店 send-to-current-conversation 专项测试 ===');

  const result = await withTempDb(async () => {
    const missingConfirmBlocked = await testMissingConfirmBlocked();
    const noSelectedBlocked = await testNoSelectedBlocked();
    const editorMissingBlocked = await testEditorMissingBlocked();
    const sendButtonMissingBlocked = await testSendButtonMissingBlocked();
    const selectedOnlySendAllowed = await testSelectedOnlySendAllowed();
    const mockSuccess = await testMockSuccess();
    const sqliteOutboundOk = testSqliteOutboundOk(mockSuccess.report);
    const noBatchNoSwitch = testNoBatchNoSwitch();
    const gatesBuyerIdentity = testGatesRequireBuyerIdentity();

    return {
      missingConfirmBlocked,
      noSelectedBlocked,
      editorMissingBlocked,
      sendButtonMissingBlocked,
      selectedOnlySendAllowed,
      mockFillOk: mockSuccess.mockFillOk,
      mockSendClickOk: mockSuccess.mockSendClickOk,
      verifyInChatOk: mockSuccess.verifyInChatOk,
      sqliteOutboundOk,
      noBatchNoSwitch,
      gatesBuyerIdentity,
    };
  });

  console.log(JSON.stringify(result, null, 2));
  const allOk = Object.values(result).every(Boolean);
  console.log(allOk ? '\n全部通过' : '\n存在失败项');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('test-send-to-current-conversation 异常:', err.message || err);
  process.exit(1);
});
