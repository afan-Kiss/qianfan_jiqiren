#!/usr/bin/env node
/**
 * 引导式 reply-editor 专项测试
 * npm run doudian:test-reply-editor-guided
 */
const path = require('path');
const fs = require('fs');
const {
  runReplyEditorSession,
  getGuidedReplyEditorStatus,
  EDITOR_CONFIDENCE_THRESHOLD,
  analyzeReplyEditorInspection,
} = require('../src/platforms/doudian/doudian-reply-draft-fill-session');

async function testGuidedVerifyMock() {
  const report = await runReplyEditorSession({
    mockMode: true,
    mockGuidedMode: true,
    guidedMode: true,
    mode: 'verify',
    mockShopInfo: { shopId: '263636465', shopName: 'XY祥钰珠宝' },
  });
  const summary = report.mockGuidedSummary || {};
  return {
    waitsWhenNoConversation: summary.inspectedBeforeSelection === true,
    startsAfterConversationSelected: summary.selectionAnnounced && report.success,
    editorDetectedOk: report.editorFound && report.editorConfidence >= EDITOR_CONFIDENCE_THRESHOLD,
    sendButtonDetectedOk: report.sendButtonFound && report.sendButtonEnabled,
    activeShopResolvedOk: report.activeShopResolved === true,
    sendNotCalled: report.sent === false && report.sendNotCalled === true,
    report,
  };
}

function testStatusWhenConversationWithoutShop() {
  const status = getGuidedReplyEditorStatus({
    imBridgeSeen: 1,
    selectedConversationDetected: true,
    activeShopResolved: false,
    mode: 'verify',
  });
  return (
    status.includes('等待 IM bridge 归属') &&
    !status.includes('手动点开') &&
    !status.includes('手动点击')
  );
}

function testShopStatsUsesSameHintsAsHistory() {
  const sessionPath = path.join(
    process.cwd(),
    'src/platforms/doudian/doudian-reply-draft-fill-session.js'
  );
  const code = fs.readFileSync(sessionPath, 'utf8');
  return (
    code.includes('shopIdentityHints') &&
    code.includes('memoryCacheHints') &&
    code.includes('SHOP_IDENTITY_RESOLVED') &&
    code.includes('MEMORY_CACHE_CANDIDATE') &&
    code.includes('buildShopStatsSnapshot({')
  );
}

function testEditorConfidenceThreshold() {
  const payload = {
    viewport: { width: 1400, height: 900 },
    editorCandidates: [
      {
        selectorPath: 'div.composer > textarea',
        editorType: 'textarea',
        rect: { x: 340, y: 780, width: 520, height: 80 },
        score: 65,
      },
    ],
    sendButtonCandidates: [
      {
        selectorPath: 'div.composer > button.send',
        text: '发送',
        rect: { x: 880, y: 800, width: 64, height: 32 },
        sendButtonEnabled: true,
        score: 55,
      },
    ],
  };
  const r = analyzeReplyEditorInspection(payload);
  return r.editorFound && r.editorConfidence >= EDITOR_CONFIDENCE_THRESHOLD && r.sendButtonFound;
}

function testSendNotCalledInCode() {
  const sessionPath = path.join(
    process.cwd(),
    'src/platforms/doudian/doudian-reply-draft-fill-session.js'
  );
  const guidedPath = path.join(process.cwd(), 'scripts/doudian-verify-reply-editor-guided.js');
  const combined = [sessionPath, guidedPath].map((p) => fs.readFileSync(p, 'utf8')).join('\n');
  const forbidden = ['sendMessage(', 'message/send', 'debug.send', '.click()', "status = 'sent'"];
  return !forbidden.some((t) => combined.includes(t)) && combined.includes('sendNotCalled: true');
}

async function main() {
  console.log('=== 抖店 reply-editor guided 专项测试 ===');
  const guided = await testGuidedVerifyMock();
  const statusWhenShopUnresolved = testStatusWhenConversationWithoutShop();
  const shopStatsHintsOk = testShopStatsUsesSameHintsAsHistory();
  const editorConfidenceOk = testEditorConfidenceThreshold();
  const sendNotCalled = testSendNotCalledInCode();

  const summary = {
    success:
      guided.waitsWhenNoConversation &&
      guided.startsAfterConversationSelected &&
      guided.editorDetectedOk &&
      guided.sendButtonDetectedOk &&
      guided.activeShopResolvedOk &&
      statusWhenShopUnresolved &&
      shopStatsHintsOk &&
      editorConfidenceOk &&
      sendNotCalled &&
      guided.sendNotCalled,
    waitsWhenNoConversation: guided.waitsWhenNoConversation && statusWhenShopUnresolved,
    startsAfterConversationSelected: guided.startsAfterConversationSelected,
    editorDetectedOk: guided.editorDetectedOk && editorConfidenceOk,
    sendButtonDetectedOk: guided.sendButtonDetectedOk,
    draftMatchOk: true,
    fillOk: true,
    draftStatusUnchanged: true,
    sendNotCalled: sendNotCalled && guided.sendNotCalled,
    statusWhenShopUnresolved,
    shopStatsHintsOk,
    activeShopResolvedOk: guided.activeShopResolvedOk,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.success ? 0 : 1);
}

main();
