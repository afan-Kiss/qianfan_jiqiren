#!/usr/bin/env node
/**
 * 抖店 send-message-to-buyer 专项测试
 * npm run doudian:test-send-message-to-buyer
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  runMessageSendSession,
  matchesTargetBuyerName,
  REQUIRED_SEND_SHOP_ID,
} = require('../src/platforms/doudian/doudian-message-send-session');
const {
  getLatestOutboundMessage,
  getReplyDraftById,
  closeDb,
} = require('../src/platforms/doudian/doudian-data-store');

function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doudian-send-test-'));
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
  const report = await runMessageSendSession({
    mockMode: false,
    confirmSend: false,
    text: '测试',
    targetBuyerName: '一只小青蛙',
  });
  return report.reason === 'missing_confirm_send' && report.sent === false;
}

async function testBuyerMismatchBlocked() {
  const report = await runMessageSendSession({
    mockMode: true,
    mockScenario: 'buyer_mismatch',
    confirmSend: true,
    text: '测试',
    targetBuyerName: '一只小青蛙',
  });
  return report.reason === 'target_buyer_mismatch' && report.sent === false;
}

async function testShopMismatchBlocked() {
  const report = await runMessageSendSession({
    mockMode: true,
    mockScenario: 'shop_mismatch',
    confirmSend: true,
    text: '测试',
    targetBuyerName: '一只小青蛙',
  });
  return report.reason === 'shop_id_mismatch' && report.sent === false;
}

async function testEditorMissingBlocked() {
  const report = await runMessageSendSession({
    mockMode: true,
    mockScenario: 'editor_missing',
    confirmSend: true,
    text: '测试',
    targetBuyerName: '一只小青蛙',
  });
  return report.reason === 'reply_editor_not_found' && report.sent === false;
}

async function testSendButtonMissingBlocked() {
  const report = await runMessageSendSession({
    mockMode: true,
    mockScenario: 'send_button_missing',
    confirmSend: true,
    text: '测试',
    targetBuyerName: '一只小青蛙',
  });
  return report.reason === 'send_button_not_found' && report.sent === false;
}

async function testMockSuccess() {
  const report = await runMessageSendSession({
    mockMode: true,
    mockScenario: 'success',
    confirmSend: true,
    text: '亲亲，在的',
    targetBuyerName: '一只小青蛙',
  });
  return {
    mockFillOk: report.filled === true && report.fillVerified === true,
    mockSendClickOk: report.sendClicked === true,
    verifyInChatOk: report.verifiedInChat === true && report.reason === 'message_sent_and_verified',
    report,
  };
}

function testBuyerNameMatch() {
  return (
    matchesTargetBuyerName('一只小青蛙', '一只小青蛙123', []) &&
    matchesTargetBuyerName('一只小青蛙', '', ['买家一只小青蛙在线']) &&
    !matchesTargetBuyerName('一只小青蛙', '其他买家', [])
  );
}

function testSqliteOutboundOk(report) {
  const row = getLatestOutboundMessage();
  return (
    row &&
    row.status === 'sent' &&
    row.verified_in_chat === 1 &&
    row.shop_id === REQUIRED_SEND_SHOP_ID &&
    report.outboundMessageId === row.id
  );
}

function testDraftStatusUnchanged() {
  const sessionPath = path.join(
    process.cwd(),
    'src/platforms/doudian/doudian-message-send-session.js'
  );
  const snippetPath = path.join(
    process.cwd(),
    'src/platforms/doudian/injected/doudian-message-send-snippet.js'
  );
  const combined = [sessionPath, snippetPath].map((p) => fs.readFileSync(p, 'utf8')).join('\n');
  return (
    !combined.includes('platform_reply_drafts') &&
    !combined.includes("status = 'sent'") &&
    !combined.includes('getReplyDraftById')
  );
}

async function main() {
  console.log('=== 抖店 send-message-to-buyer 专项测试 ===');

  const result = await withTempDb(async () => {
    const missingConfirmBlocked = await testMissingConfirmBlocked();
    const buyerMismatchBlocked = await testBuyerMismatchBlocked();
    const shopMismatchBlocked = await testShopMismatchBlocked();
    const editorMissingBlocked = await testEditorMissingBlocked();
    const sendButtonMissingBlocked = await testSendButtonMissingBlocked();
    const buyerNameMatchOk = testBuyerNameMatch();
    const mock = await testMockSuccess();
    const sqliteOutboundOk = testSqliteOutboundOk(mock.report);
    const draftStatusUnchanged = testDraftStatusUnchanged();

    let draftStillDraftOnly = true;
    try {
      const draft = getReplyDraftById(1);
      if (draft && draft.status !== 'draft_only') draftStillDraftOnly = false;
    } catch {
      draftStillDraftOnly = true;
    }

    return {
      success:
        missingConfirmBlocked &&
        buyerMismatchBlocked &&
        shopMismatchBlocked &&
        editorMissingBlocked &&
        sendButtonMissingBlocked &&
        buyerNameMatchOk &&
        mock.mockFillOk &&
        mock.mockSendClickOk &&
        mock.verifyInChatOk &&
        sqliteOutboundOk &&
        draftStatusUnchanged &&
        draftStillDraftOnly,
      missingConfirmBlocked,
      buyerMismatchBlocked,
      shopMismatchBlocked,
      editorMissingBlocked,
      sendButtonMissingBlocked,
      buyerNameMatchOk,
      mockFillOk: mock.mockFillOk,
      mockSendClickOk: mock.mockSendClickOk,
      verifyInChatOk: mock.verifyInChatOk,
      sqliteOutboundOk,
      draftStatusUnchanged,
      draftStillDraftOnly,
    };
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
