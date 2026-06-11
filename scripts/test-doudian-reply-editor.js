#!/usr/bin/env node
/**
 * 客服输入框检测专项测试
 * npm run doudian:test-reply-editor
 */
const {
  analyzeReplyEditorInspection,
  scoreEditorCandidate,
  scoreSendButtonCandidate,
} = require('../src/platforms/doudian/doudian-reply-editor-detector');

function buildTextareaInspection() {
  return {
    viewport: { width: 1400, height: 900 },
    editorCandidates: [
      {
        selectorPath: 'div.composer > textarea.reply-input',
        editorType: 'textarea',
        rect: { x: 340, y: 780, width: 520, height: 80 },
        editorTextBefore: '',
        placeholder: '请输入消息',
        className: 'reply-input composer-textarea',
        score: 45,
      },
      {
        selectorPath: 'div.search-box > input',
        editorType: 'textbox',
        rect: { x: 120, y: 60, width: 200, height: 32 },
        placeholder: '搜索会话',
        className: 'search-input',
        score: 10,
      },
      {
        selectorPath: 'div.remark-panel > textarea',
        editorType: 'textarea',
        rect: { x: 980, y: 200, width: 260, height: 60 },
        placeholder: '添加备注',
        className: 'remark-textarea',
        score: 15,
      },
    ],
    sendButtonCandidates: [
      {
        selectorPath: 'div.composer > button.send-btn',
        text: '发送',
        rect: { x: 880, y: 800, width: 64, height: 32 },
        sendButtonEnabled: true,
        score: 40,
      },
      {
        selectorPath: 'div.toolbar > button',
        text: '转人工',
        rect: { x: 400, y: 740, width: 72, height: 28 },
        score: 5,
      },
      {
        selectorPath: 'div.toolbar > button',
        text: '发送商品卡片',
        rect: { x: 500, y: 740, width: 100, height: 28 },
        score: 5,
      },
    ],
  };
}

function buildContenteditableInspection() {
  return {
    viewport: { width: 1400, height: 900 },
    editorCandidates: [
      {
        selectorPath: 'div.reply-box > div[contenteditable="true"]',
        editorType: 'contenteditable',
        rect: { x: 360, y: 790, width: 480, height: 72 },
        editorTextBefore: '',
        className: 'editor-area reply-composer',
        score: 50,
      },
    ],
    sendButtonCandidates: [
      {
        selectorPath: 'div.reply-box > button.submit',
        text: 'Send',
        rect: { x: 860, y: 805, width: 60, height: 30 },
        sendButtonEnabled: true,
        score: 42,
      },
    ],
  };
}

function testTextareaDetected() {
  const r = analyzeReplyEditorInspection(buildTextareaInspection());
  return r.editorFound && r.editorType === 'textarea' && r.editorConfidence >= 40;
}

function testContenteditableDetected() {
  const r = analyzeReplyEditorInspection(buildContenteditableInspection());
  return r.editorFound && r.editorType === 'contenteditable';
}

function testSearchBoxRejected() {
  const search = scoreEditorCandidate(
    {
      selectorPath: 'div.search-box > input',
      editorType: 'textbox',
      rect: { x: 100, y: 50, width: 180, height: 30 },
      placeholder: '搜索会话',
      score: 10,
    },
    { width: 1400, height: 900 }
  );
  return !search.trusted && search.rejectReasons.includes('blocked_editor_zone');
}

function testRemarkBoxRejected() {
  const remark = scoreEditorCandidate(
    {
      selectorPath: 'div.remark-panel > textarea',
      editorType: 'textarea',
      rect: { x: 980, y: 200, width: 260, height: 60 },
      placeholder: '添加备注',
      className: 'remark-textarea',
      score: 15,
    },
    { width: 1400, height: 900 }
  );
  return !remark.trusted;
}

function testSendButtonDetected() {
  const r = analyzeReplyEditorInspection(buildTextareaInspection());
  return r.sendButtonFound && r.sendButtonText === '发送';
}

function testBadButtonRejected() {
  const bad = scoreSendButtonCandidate(
    { text: '转人工', rect: { x: 400, y: 740, width: 72, height: 28 }, score: 5 },
    { rect: { x: 340, y: 780, width: 520, height: 80 } },
    { width: 1400, height: 900 }
  );
  const bad2 = scoreSendButtonCandidate(
    { text: '添加备注', rect: { x: 500, y: 740, width: 80, height: 28 }, score: 5 },
    { rect: { x: 340, y: 780, width: 520, height: 80 } },
    { width: 1400, height: 900 }
  );
  return !bad.trusted && !bad2.trusted && bad.rejectReasons.includes('blocked_button_text');
}

function testFillOk() {
  const snippetPath = require('path').join(
    process.cwd(),
    'src/platforms/doudian/injected/doudian-reply-editor-snippet.js'
  );
  const code = require('fs').readFileSync(snippetPath, 'utf8');
  return (
    code.includes('element.value = draftText') === false &&
    code.includes('setNativeValue(el, draftText)') &&
    code.includes('sent: false') &&
    code.includes('sendNotCalled: true') &&
    !code.includes('.click()')
  );
}

function testSendNotCalled() {
  const paths = [
    'src/platforms/doudian/doudian-reply-draft-fill-session.js',
    'src/platforms/doudian/injected/doudian-reply-editor-snippet.js',
    'scripts/doudian-fill-reply-draft.js',
    'scripts/doudian-verify-reply-editor.js',
  ];
  const combined = paths
    .map((p) => require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8'))
    .join('\n');
  const forbidden = [
    'sendMessage(',
    'message/send',
    'debug.send',
    '.click()',
    'status = \'sent\'',
    "status = \"sent\"",
  ];
  return !forbidden.some((token) => combined.includes(token)) && combined.includes('sendNotCalled: true');
}

function testMismatchRejected() {
  const { matchDraftToConversation } = require('../src/platforms/doudian/doudian-reply-editor-detector');
  const r = matchDraftToConversation(
    { shop_id: '263636465', buyer_id: 'buyer_a', conversation_id: 'conv_a' },
    { shopId: '263636465', buyerId: 'buyer_b', conversationId: 'conv_b' }
  );
  return !r.matched && !r.buyerMatched;
}

function testRiskBlockedRejected() {
  const sessionPath = require('path').join(
    process.cwd(),
    'src/platforms/doudian/doudian-reply-draft-fill-session.js'
  );
  const code = require('fs').readFileSync(sessionPath, 'utf8');
  return code.includes("status === 'risk_blocked'") && code.includes('risk_blocked_draft');
}

function main() {
  console.log('=== 抖店 reply-editor 专项测试 ===');

  const textareaDetected = testTextareaDetected();
  const contenteditableDetected = testContenteditableDetected();
  const searchBoxRejected = testSearchBoxRejected();
  const remarkBoxRejected = testRemarkBoxRejected();
  const sendButtonDetected = testSendButtonDetected();
  const badButtonRejected = testBadButtonRejected();
  const fillOk = testFillOk();
  const sendNotCalled = testSendNotCalled();
  const mismatchRejected = testMismatchRejected();
  const riskBlockedRejected = testRiskBlockedRejected();

  const summary = {
    success:
      textareaDetected &&
      contenteditableDetected &&
      searchBoxRejected &&
      remarkBoxRejected &&
      sendButtonDetected &&
      badButtonRejected &&
      fillOk &&
      sendNotCalled &&
      mismatchRejected &&
      riskBlockedRejected,
    textareaDetected,
    contenteditableDetected,
    searchBoxRejected,
    remarkBoxRejected,
    sendButtonDetected,
    badButtonRejected,
    fillOk,
    sendNotCalled,
    mismatchRejected,
    riskBlockedRejected,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.success ? 0 : 1);
}

main();
