const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function writeReportBundle({ reportDir, scenario, metrics, invariants, errors, leak, passed }) {
  ensureDir(reportDir);
  const summary = {
    scenario: scenario.name,
    seed: scenario.seed,
    days: scenario.days,
    passed,
    generatedAt: new Date().toISOString(),
    metrics,
    invariantCount: invariants.length,
    errorCount: errors.length,
  };

  writeJson(path.join(reportDir, 'summary.json'), summary);
  writeJson(path.join(reportDir, 'metrics.json'), metrics);
  writeJson(path.join(reportDir, 'invariants.json'), invariants);
  writeJson(path.join(reportDir, 'errors.json'), errors);

  const md = [
    '# Longrun Simulation Report',
    '',
    `场景名称：${scenario.name}`,
    `随机种子：${scenario.seed}`,
    `模拟天数：${metrics.daysSimulated}`,
    `买家消息数：${metrics.buyerMessagesGenerated}（唯一 ${metrics.uniqueBuyerMessages}）`,
    `微信回复数：${metrics.wechatRepliesGenerated}（唯一 ${metrics.uniqueWechatReplies}）`,
    `通知成功/失败：${metrics.notificationsSucceeded}/${metrics.notificationsFailed}`,
    `千帆发送成功/失败：${metrics.qianfanSendSucceeded}/${metrics.qianfanSendFailed}`,
    `千帆实际发送次数：${metrics.qianfanSendActualAttempts}`,
    `千帆请求发布/去重：${metrics.qianfanSendRequestsPublished}/${metrics.qianfanSendRequestsDeduped}`,
    `失败回执数：${metrics.failureReceiptsSent}（实际 ${metrics.failureReceiptActualSent}，唯一 key ${metrics.uniqueFailureReceiptKeys}）`,
    `成功回执数：${metrics.successReceiptsSent}`,
    `deadLetter 数：${metrics.deadLetters}`,
    `worker crash 次数：${metrics.workerCrashes}`,
    `watchdog timeout 次数：${metrics.watchdogTimeouts}`,
    `worker restart 次数：${metrics.workerRestarts}`,
    `熔断次数：${metrics.restartCircuitBreaks}`,
    `persistence timeout 次数：${metrics.persistenceTimeouts}`,
    `最大内存：${metrics.maxMemoryMB} MB`,
    `active handles 起止：${metrics.activeHandlesStart} -> ${metrics.activeHandlesEnd}`,
    `不变量失败数：${metrics.invariantFailures.length}`,
    `结论：${passed ? 'PASS' : 'FAIL'}`,
    '',
  ];

  if (leak?.warnings?.length) {
    md.push('## Warnings', ...leak.warnings.map((w) => `- ${w}`), '');
  }
  if (errors.length) {
    md.push('## Errors', ...errors.map((e) => `- ${e}`), '');
  }

  fs.writeFileSync(path.join(reportDir, 'summary.md'), md.join('\n'), 'utf8');
  return summary;
}

module.exports = {
  writeReportBundle,
};
