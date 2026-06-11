const { hasTrustedBuyerIdentity } = require('./doudian-conversation-sources-resolver');

const GUIDED_POLL_MS = 5000;
const GUIDED_BRIEFING_MS = 5000;
const GUIDED_DEFAULT_TIMEOUT_MINUTES = 30;

const EMPTY_STATE_TEXT_RE =
  /您今日暂无接待数据|暂无会话中用户|请选择会话|当前会话|最近联系|在线|三方|个人短语|添加备注|客户资料|店铺消费|商家后台|AI智能客服|暂无接待|全店数据|前往查看|与消费者聊天/;

function parseGuidedTimeoutMinutes(argv = [], defaultMinutes = GUIDED_DEFAULT_TIMEOUT_MINUTES) {
  let timeoutMinutes = defaultMinutes;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--timeout-minutes' && argv[i + 1]) {
      timeoutMinutes = Math.max(1, Number(argv[++i]) || defaultMinutes);
    }
  }
  return timeoutMinutes;
}

function isEmptyStateText(text = '') {
  const n = String(text || '').trim();
  if (!n) return false;
  return EMPTY_STATE_TEXT_RE.test(n);
}

function getActiveShopLine(report = {}) {
  const shop = report.activeShop || {};
  return {
    shopId: shop.shopId || report.shopId || '',
    shopName: shop.shopName || report.shopName || '',
  };
}

function isGuidedConversationReady(report = {}) {
  return (
    (report.imBridgeSeen || 0) >= 1 &&
    Boolean(report.activeShopResolved) &&
    Boolean(report.selectedConversationDetected) &&
    hasTrustedBuyerIdentity({
      buyerId: report.buyerId || report.selectedConversation?.buyerId,
      buyerName: report.buyerName || report.selectedConversation?.buyerName,
    })
  );
}

function detectEmptyStateFromReport(report = {}) {
  const candidates = [
    report.buyerName,
    report.selectedConversation?.buyerName,
    report.emptyStateText,
    ...(report.conversations || []).map((c) => c.buyerName),
    ...((report.sourcesInspection?.domList?.items || []).map((i) => i.buyerName)),
    ...((report.sourcesInspection?.memoryCache?.conversations || []).map((c) => c.buyerName)),
  ];
  for (const text of candidates) {
    if (isEmptyStateText(text)) {
      return { detected: true, text: String(text).slice(0, 120) };
    }
  }
  return { detected: false, text: '' };
}

function getGuidedConversationStatus(report = {}) {
  if (!report.activeShopResolved) {
    return '等待店铺归属识别，请确认 IM 已登录目标店铺';
  }
  const trusted = hasTrustedBuyerIdentity(report);
  if (!trusted) {
    const empty = detectEmptyStateFromReport(report);
    if (empty.detected) {
      return '当前为空状态，请在抖店 IM 中手动点开要发送的买家会话，例如「一只小青蛙」';
    }
    if (report.selectedConversationDetected) {
      return '已识别会话上下文，等待买家昵称/ID 确认，请保持当前聊天窗口打开';
    }
    return '请在抖店 IM 中手动点开要发送的买家会话，例如「一只小青蛙」';
  }
  return '已检测到当前买家会话';
}

function printGuidedConversationBriefing(report, label = 'conversation guided') {
  const active = getActiveShopLine(report);
  console.log(`[抖店桥] ${label}:`);
  console.log(`IM已打开: ${(report.imBridgeSeen || 0) >= 1}`);
  console.log(`activeShop: ${active.shopId} / ${active.shopName}`);
  console.log(`activeShopResolved: ${Boolean(report.activeShopResolved)}`);
  console.log(`selectedConversationDetected: ${Boolean(report.selectedConversationDetected)}`);
  if (report.buyerName) console.log(`buyerName: ${report.buyerName}`);
  if (report.buyerId) console.log(`buyerId: ${report.buyerId}`);
  if (report.conversationId) console.log(`conversationId: ${report.conversationId}`);
  const status = getGuidedConversationStatus(report);
  if (status === '已检测到当前买家会话') {
    console.log('[抖店桥] 已检测到当前买家会话');
    if (report.buyerName) console.log(`buyerName: ${report.buyerName}`);
    if (report.buyerId) console.log(`buyerId: ${report.buyerId}`);
    if (report.conversationId) console.log(`conversationId: ${report.conversationId}`);
  } else {
    console.log(`状态: ${status}`);
  }
}

function syncGuidedSourceCounts(report) {
  const summary = report.summary || {};
  const sources = report.sourcesInspection || {};
  report.memoryCacheConversationCount =
    summary.memoryCacheCount ??
    sources.memoryCache?.conversationCount ??
    sources.memoryCache?.conversations?.length ??
    0;
  report.reactFiberConversationLikeObjectCount =
    summary.reactFiberCount ??
    sources.reactFiber?.conversationLikeObjectCount ??
    sources.reactFiber?.conversations?.length ??
    0;
  report.domListItemCount =
    summary.domGeometryCount ??
    sources.domList?.itemCount ??
    sources.domList?.items?.length ??
    0;
}

function applyEmptyStateFlags(report) {
  const empty = detectEmptyStateFromReport(report);
  report.emptyStateDetected = empty.detected;
  report.emptyStateText = empty.text;
  if (empty.detected && !hasTrustedBuyerIdentity(report)) {
    report.selectedConversationDetected = false;
  }
}

module.exports = {
  GUIDED_POLL_MS,
  GUIDED_BRIEFING_MS,
  GUIDED_DEFAULT_TIMEOUT_MINUTES,
  EMPTY_STATE_TEXT_RE,
  parseGuidedTimeoutMinutes,
  isEmptyStateText,
  isGuidedConversationReady,
  detectEmptyStateFromReport,
  getGuidedConversationStatus,
  printGuidedConversationBriefing,
  syncGuidedSourceCounts,
  applyEmptyStateFlags,
  getActiveShopLine,
};
