#!/usr/bin/env node
/**
 * 抖店 conversation-sources guided 专项测试
 * npm run doudian:test-conversation-sources-guided
 */
const fs = require('fs');
const path = require('path');
const {
  runConversationSourcesGuidedSession,
} = require('../src/platforms/doudian/doudian-conversation-sources-session');
const { isEmptyStateText } = require('../src/platforms/doudian/doudian-conversation-guided-shared');

async function testEmptyStateKeepsWaiting() {
  const report = await runConversationSourcesGuidedSession({
    mockMode: true,
    mockScenario: 'empty_then_wait',
  });
  return (
    report.success === false &&
    report.emptyStateDetected === true &&
    report.selectedConversationDetected === false &&
    report.mockGuidedSummary?.inspectedWhileEmpty === true
  );
}

async function testSelectionDetectedSuccess() {
  const report = await runConversationSourcesGuidedSession({
    mockMode: true,
    mockScenario: 'selected',
  });
  return (
    report.success === true &&
    report.reason === 'conversation_selected' &&
    report.selectedConversationDetected === true &&
    (report.buyerName || '').includes('一只小青蛙')
  );
}

async function testTimeoutNoSelection() {
  const report = await runConversationSourcesGuidedSession({
    mockMode: true,
    mockScenario: 'timeout',
  });
  return report.success === false && report.reason === 'timeout_no_selected_conversation';
}

function testEmptyStatePatterns() {
  return (
    isEmptyStateText('您今日暂无接待数据') &&
    isEmptyStateText('暂无会话中用户') &&
    isEmptyStateText('请选择会话') &&
    !isEmptyStateText('一只小青蛙')
  );
}

function testNoAutoSwitch() {
  const sessionPath = path.join(
    process.cwd(),
    'src/platforms/doudian/doudian-conversation-sources-session.js'
  );
  const code = fs.readFileSync(sessionPath, 'utf8');
  return !code.includes('switch_conversation') && !code.includes('.click(');
}

async function main() {
  console.log('=== 抖店 conversation-sources guided 专项测试 ===');

  const emptyKeepsWaiting = await testEmptyStateKeepsWaiting();
  const selectionDetected = await testSelectionDetectedSuccess();
  const timeoutNoSelection = await testTimeoutNoSelection();
  const emptyPatterns = testEmptyStatePatterns();
  const noAutoSwitch = testNoAutoSwitch();

  const result = {
    success:
      emptyKeepsWaiting &&
      selectionDetected &&
      timeoutNoSelection &&
      emptyPatterns &&
      noAutoSwitch,
    emptyKeepsWaiting,
    selectionDetected,
    timeoutNoSelection,
    emptyPatterns,
    noAutoSwitch,
  };

  console.log(JSON.stringify(result, null, 2));
  console.log(result.success ? '\n全部通过' : '\n存在失败项');
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error('test-conversation-sources-guided 异常:', err.message || err);
  process.exit(1);
});
