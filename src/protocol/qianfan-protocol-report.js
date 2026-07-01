/**
 * 千帆纯协议测试 — 统一报告输出
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { resolveProjectRoot } = require('../shared/app-root');

function getGitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: resolveProjectRoot() }).trim();
  } catch {
    return 'unknown';
  }
}

function reportTimestamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day}-${hh}${mm}${ss}`;
}

function reportFilePath() {
  const dir = path.join(resolveProjectRoot(), 'logs', 'debug');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `qianfan-protocol-test-${reportTimestamp()}.json`);
}

function inferGaps(report) {
  const gaps = [];
  const shop = report.shopProbe || {};
  const listen = report.listen || {};
  const list = report.messageList || {};
  const text = report.textSend || {};
  const image = report.imageAnalyze || report.imageSend || {};

  if (!shop.hasWsUrl) gaps.push('缺 ws.url');
  if (!shop.hasTestAppCid) gaps.push('缺 appCid');
  if (!shop.hasReceiverAppUids) gaps.push('缺 receiverAppUids');
  if (!shop.hasMessageListUrl) gaps.push('缺 messageList HTTP 模板 URL');
  if (!shop.hasImageUploadUrl) gaps.push('缺 image upload template');
  if (!shop.hasImageSendPayloadSample) gaps.push('缺 manual image WS payload sample');

  if (listen.errors?.length) {
    for (const e of listen.errors) gaps.push(`WS listen: ${e}`);
  }
  if (listen.connected === false && shop.hasWsUrl) gaps.push('WS 握手失败或未连接');
  if (list.status === 401 || list.status === 403) gaps.push('Cookie 401/403');
  if (text.error && /ACK/i.test(text.error)) gaps.push('ACK 超时');
  if (image.missingFields?.length) {
    for (const f of image.missingFields) gaps.push(`图片: ${f}`);
  }

  return [...new Set(gaps)];
}

function buildConclusions(report) {
  const shop = report.shopProbe || {};
  const listen = report.listen || {};
  const list = report.messageList || {};
  const textDry = report.textSend?.dryRun || report.textSend;
  const textReal = report.textSend?.reallySend;
  const imageAnalyze = report.imageAnalyze || {};

  return {
    pureListenReady: Boolean(shop.hasWsUrl && listen.ok && listen.connected),
    pureHttpPullReady: Boolean(shop.hasMessageListUrl && list.ok && (list.messageCount || 0) >= 0),
    pureTextSendReady: Boolean(
      shop.hasWsUrl &&
        shop.hasTestAppCid &&
        shop.hasReceiverAppUids &&
        textDry?.ok !== false &&
        (textDry?.payloadValid || textDry?.dryRun === true)
    ),
    pureImageSendReady: Boolean(imageAnalyze.canReallySendImage === true),
    textReallySendAttempted: Boolean(textReal && !textReal.skipped),
    textReallySendOk: Boolean(textReal?.ok),
    imageReallySendAttempted: Boolean(report.imageSend?.reallySend),
    imageReallySendOk: Boolean(report.imageSend?.ok),
  };
}

function writeProtocolReport(partialReport = {}) {
  const report = {
    generatedAt: new Date().toISOString(),
    gitCommit: getGitCommit(),
    nodeVersion: process.version,
    ...partialReport,
  };

  if (!report.conclusions) {
    report.conclusions = buildConclusions(report);
  }
  if (!report.nextStepGaps) {
    report.nextStepGaps = inferGaps(report);
  }

  const filePath = report.reportPath || reportFilePath();
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  report.reportPath = filePath;
  return report;
}

function printProtocolSummary(report) {
  const c = report.conclusions || {};
  const gaps = report.nextStepGaps || [];
  console.log('\n========== 千帆纯协议测试报告 ==========');
  console.log(`Git commit: ${report.gitCommit}`);
  console.log(`Node: ${report.nodeVersion}`);
  console.log(`店铺: ${report.shopTitle || '-'}`);
  console.log(`报告文件: ${report.reportPath}`);
  console.log('--- 能力判断 ---');
  console.log(`纯协议监听可行: ${c.pureListenReady}`);
  console.log(`纯协议 HTTP 拉消息可行: ${c.pureHttpPullReady}`);
  console.log(`纯协议文字发送可行(dry-run层面): ${c.pureTextSendReady}`);
  console.log(`纯协议图片发送可行: ${c.pureImageSendReady}`);
  if (gaps.length) {
    console.log('--- 下一步缺口 ---');
    for (const g of gaps) console.log(`  - ${g}`);
  }
  console.log('========================================\n');
}

module.exports = {
  getGitCommit,
  reportFilePath,
  writeProtocolReport,
  printProtocolSummary,
  buildConclusions,
  inferGaps,
};
