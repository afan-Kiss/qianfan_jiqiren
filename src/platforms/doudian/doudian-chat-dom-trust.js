const { isHistoryUiText, isBlockedBuyerName } = require('./doudian-history-validation');
const { maskMessageForReport } = require('./doudian-shop-utils');

const TRUSTED_AREA_SCORE = 40;
const TRUSTED_BUBBLE_SCORE = 25;
const UI_TEXT_RE =
  /拖拽到此发送|添加备注|店铺消费|抖音-商品详情页|个人短语|团队短语|快捷短语|接待工具|客户资料|更多/;

function normalizeDirection(direction) {
  const d = String(direction || '').toLowerCase();
  if (d === 'seller' || d === 'outbound' || d === 'service') return 'seller';
  if (d === 'buyer' || d === 'inbound' || d === 'customer' || d === 'user') return 'buyer';
  return 'unknown';
}

function isUiBubbleText(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (isHistoryUiText(t)) return true;
  if (UI_TEXT_RE.test(t)) return true;
  if (/^(发送|确定|取消|更多|图片|表情|订单|售后)$/.test(t)) return true;
  return false;
}

function scoreMessageArea(area = {}) {
  let score = Number(area.score || 0);
  const reasons = Array.isArray(area.reason) ? [...area.reason] : [];
  const rect = area.rect || {};
  const w = Number(rect.width || 0);
  const h = Number(rect.height || 0);
  const textLen = Number(area.textLength || 0);
  const scrollHeight = Number(area.scrollHeight || 0);
  const clientHeight = Number(area.clientHeight || 0);

  if (h >= 200) {
    score += 10;
    reasons.push('height_ok');
  }
  if (scrollHeight > clientHeight + 20) {
    score += 12;
    reasons.push('scrollable');
  }
  if (textLen >= 30 && textLen <= 20000) {
    score += 8;
    reasons.push('text_density_ok');
  }
  if (w >= 200 && w <= 1200) {
    score += 6;
    reasons.push('width_like_chat');
  }

  const sample = String(area.sampleText || '');
  if (/\d{1,2}:\d{2}(:\d{2})?/.test(sample) || /昨天|今天|前天/.test(sample)) {
    score += 10;
    reasons.push('has_time_text');
  }

  const cls = String(area.className || '').toLowerCase();
  const id = String(area.id || '').toLowerCase();
  const hint = cls + ' ' + id;
  if (/conversation-list|session-list|sidebar|profile|phrase|input|toolbar|nav/.test(hint)) {
    score -= 30;
    reasons.push('excluded_zone');
  }

  return { score, reasons, trusted: score >= TRUSTED_AREA_SCORE };
}

function scoreBubble(bubble = {}, areaContext = {}) {
  let score = Number(bubble.score || 0);
  const reasons = [];
  const rejectReasons = [];
  const text = String(bubble.text || '').trim();
  const rect = bubble.rect || {};
  const w = Number(rect.width || 0);
  const h = Number(rect.height || 0);

  if (!text || text.length < 2) {
    rejectReasons.push('empty_text');
    return { score: 0, reasons, rejectReason: 'empty_text', trusted: false };
  }
  if (isUiBubbleText(text)) {
    rejectReasons.push('ui_noise_text');
    return { score: 0, reasons, rejectReason: 'ui_noise_text', trusted: false };
  }

  score += 10;
  reasons.push('natural_text');

  if (bubble.nearTimeText) {
    score += 12;
    reasons.push('near_time');
  }
  if (w >= 40 && w <= 600 && h >= 16 && h <= 400) {
    score += 8;
    reasons.push('bubble_shape');
  }
  if (areaContext.trusted) {
    score += 10;
    reasons.push('in_trusted_area');
  }
  if (bubble.directionGuess === 'buyer' || bubble.directionGuess === 'seller') {
    score += 6;
    reasons.push('direction_guess');
  } else {
    score -= 4;
    reasons.push('direction_unknown');
  }

  const parentPath = String(bubble.parentSelectorPath || '').toLowerCase();
  if (/profile|phrase|sidebar|session-list|conversation-list|input|toolbar/.test(parentPath)) {
    score -= 25;
    rejectReasons.push('side_panel_or_list');
  }

  const trusted = score >= TRUSTED_BUBBLE_SCORE && rejectReasons.length === 0;
  return {
    score,
    reasons,
    rejectReason: trusted ? '' : rejectReasons[0] || 'score_too_low',
    trusted,
  };
}

function analyzeDomInspection(payload = {}) {
  const areas = Array.isArray(payload.candidateMessageAreas) ? payload.candidateMessageAreas : [];
  const bubbles = Array.isArray(payload.candidateBubbles) ? payload.candidateBubbles : [];
  const excluded = Array.isArray(payload.excludedAreas) ? payload.excludedAreas : [];

  const scoredAreas = areas.map((a) => {
    const scored = scoreMessageArea(a);
    return { ...a, score: scored.score, reason: scored.reasons, trusted: scored.trusted };
  });
  scoredAreas.sort((a, b) => (b.score || 0) - (a.score || 0));

  const bestArea = scoredAreas[0] || null;
  const trustedAreas = scoredAreas.filter((a) => a.trusted);

  const scoredBubbles = bubbles.map((b) => {
    const areaCtx = { trusted: Boolean(bestArea && bestArea.trusted) };
    const scored = scoreBubble(b, areaCtx);
    return {
      ...b,
      score: scored.score,
      rejectReason: scored.rejectReason || b.rejectReason || '',
      trusted: scored.trusted,
    };
  });
  scoredBubbles.sort((a, b) => (b.score || 0) - (a.score || 0));

  const trustedBubbles = scoredBubbles.filter((b) => b.trusted);
  const bestBubbleSamples = trustedBubbles.slice(0, 10).map((b) =>
    maskMessageForReport({
      text: b.text,
      direction: normalizeDirection(b.directionGuess),
      messageType: b.messageType || 'text',
      source: 'dom',
    })
  );

  return {
    candidateMessageAreaCount: areas.length,
    candidateBubbleCount: bubbles.length,
    trustedMessageAreaCount: trustedAreas.length,
    trustedBubbleCount: trustedBubbles.length,
    bestMessageArea: bestArea,
    bestBubbleSamples,
    trustedBubbles,
    trustedAreas,
    excludedAreaCount: excluded.length,
    domInspectionSummary: {
      scrollContainerCount: Array.isArray(payload.scrollContainers) ? payload.scrollContainers.length : 0,
      textSampleCount: Array.isArray(payload.textSamples) ? payload.textSamples.length : 0,
      topAreaScore: bestArea?.score || 0,
      topBubbleScore: scoredBubbles[0]?.score || 0,
    },
  };
}

function bubblesToHistoryItems(trustedBubbles = []) {
  return trustedBubbles.map((b, idx) => ({
    messageId: '',
    direction: normalizeDirection(b.directionGuess),
    messageType: b.messageType || 'text',
    text: String(b.text || '').slice(0, 1000),
    timestamp: Date.now() - idx * 1000,
    domArea: 'chatBubbleArea',
    domScore: b.score,
    selectorPath: b.selectorPath || '',
  }));
}

module.exports = {
  TRUSTED_AREA_SCORE,
  TRUSTED_BUBBLE_SCORE,
  scoreMessageArea,
  scoreBubble,
  analyzeDomInspection,
  bubblesToHistoryItems,
  isUiBubbleText,
};
