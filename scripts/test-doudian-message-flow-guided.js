#!/usr/bin/env node
/**
 * 抖店 message-flow guided 专项测试
 * npm run doudian:test-message-flow-guided
 */
const fs = require('fs');
const path = require('path');
const {
  runMessageFlowGuidedSession,
  parseMessageFlowCliArgs,
  FLOW_PHASES,
} = require('../src/platforms/doudian/doudian-message-flow-guided-session');

async function testFullMockSuccess() {
  const report = await runMessageFlowGuidedSession({
    mockMode: true,
    mockScenario: 'full_success',
    text: '你好',
    confirmSend: true,
  });
  return (
    report.success === true &&
    report.reason === 'message_flow_completed' &&
    report.historyMessageCount >= 1 &&
    report.liveMessageCount >= 1 &&
    report.sent === true &&
    report.phases.history.success &&
    report.phases.listen.success &&
    report.phases.send.success
  );
}

async function testSkipSend() {
  const report = await runMessageFlowGuidedSession({
    mockMode: true,
    skipSend: true,
    confirmSend: false,
  });
  return (
    report.success === true &&
    report.reason === 'message_flow_completed_without_send' &&
    report.phases.send.reason === 'skip_send_requested'
  );
}

async function testTimeoutNoSelection() {
  const report = await runMessageFlowGuidedSession({
    mockMode: true,
    mockScenario: 'timeout_no_selection',
  });
  return report.success === false && report.reason === 'timeout_no_selected_conversation';
}

function testCliArgs() {
  const cli = parseMessageFlowCliArgs([
    '--text',
    '测试',
    '--confirm-send',
    '--listen-minutes',
    '3',
    '--timeout-minutes',
    '20',
  ]);
  return (
    cli.text === '测试' &&
    cli.confirmSend === true &&
    cli.listenMinutes === 3 &&
    cli.timeoutMinutes === 20
  );
}

function testNoAutoSwitch() {
  const sessionPath = path.join(
    process.cwd(),
    'src/platforms/doudian/doudian-message-flow-guided-session.js'
  );
  const code = fs.readFileSync(sessionPath, 'utf8');
  return !code.includes('switch_conversation') && !code.includes('.click(');
}

function testPhaseOrder() {
  return FLOW_PHASES.join(',') === 'history,listen,send';
}

async function main() {
  console.log('=== 抖店 message-flow guided 专项测试 ===');

  const fullSuccess = await testFullMockSuccess();
  const skipSend = await testSkipSend();
  const timeoutNoSelection = await testTimeoutNoSelection();
  const cliArgs = testCliArgs();
  const noAutoSwitch = testNoAutoSwitch();
  const phaseOrder = testPhaseOrder();

  const result = {
    success:
      fullSuccess &&
      skipSend &&
      timeoutNoSelection &&
      cliArgs &&
      noAutoSwitch &&
      phaseOrder,
    fullSuccess,
    skipSend,
    timeoutNoSelection,
    cliArgs,
    noAutoSwitch,
    phaseOrder,
  };

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
