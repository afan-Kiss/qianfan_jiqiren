const BLOCKED_EDITOR_RE =
  /search|remark|note|phrase|quick|shortcut|profile|sidebar|goods|product|aftersale|售后|备注|搜索|短语/i;
const BLOCKED_BUTTON_RE =
  /转人工|售后|添加备注|发送商品|发送图片|商品卡片|备注|搜索|短语|退款|同意|拒绝/i;

const EDITOR_TRUST_SCORE = 40;
const SEND_BUTTON_TRUST_SCORE = 35;
const EDITOR_CONFIDENCE_THRESHOLD = 60;

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function getRectMetrics(rect = {}) {
  return {
    x: Number(rect.x || 0),
    y: Number(rect.y || 0),
    width: Number(rect.width || 0),
    height: Number(rect.height || 0),
  };
}

function scoreEditorCandidate(candidate = {}, viewport = {}) {
  let score = Number(candidate.score || 0);
  const reasons = [];
  const rejectReasons = [];
  const rect = getRectMetrics(candidate.rect);
  const vh = Number(viewport.height || 0);
  const vw = Number(viewport.width || 0);
  const path = String(candidate.selectorPath || candidate.className || '').toLowerCase();
  const aria = String(candidate.ariaLabel || '').toLowerCase();
  const placeholder = String(candidate.placeholder || '').toLowerCase();
  const hint = `${path} ${aria} ${placeholder}`;

  if (BLOCKED_EDITOR_RE.test(hint)) {
    score -= 40;
    rejectReasons.push('blocked_editor_zone');
  }
  if (/composer|editor|textarea|textbox|reply|input-area|send-box/.test(hint)) {
    score += 15;
    reasons.push('class_hint');
  }
  if (vh > 0 && rect.y > vh * 0.55) {
    score += 20;
    reasons.push('bottom_area');
  }
  if (vw > 0 && rect.x > vw * 0.15 && rect.x + rect.width < vw * 0.95) {
    score += 10;
    reasons.push('center_x');
  }
  if (rect.width >= 120 && rect.height >= 24 && rect.height <= 260) {
    score += 10;
    reasons.push('editor_shape');
  }
  if (candidate.editorType === 'textarea' || candidate.editorType === 'contenteditable') {
    score += 12;
    reasons.push('editor_type');
  }

  const trusted = score >= EDITOR_TRUST_SCORE && rejectReasons.length === 0;
  return {
    score,
    reasons,
    rejectReasons,
    trusted,
    editorFound: trusted,
    editorConfidence: Math.min(100, Math.max(score, 0)),
  };
}

function scoreSendButtonCandidate(candidate = {}, editor = {}, viewport = {}) {
  let score = Number(candidate.score || 0);
  const reasons = [];
  const rejectReasons = [];
  const text = normalizeText(candidate.text || candidate.sendButtonText || '');
  const rect = getRectMetrics(candidate.rect);
  const editorRect = getRectMetrics(editor.rect);
  const vh = Number(viewport.height || 0);

  if (!text) {
    rejectReasons.push('empty_button_text');
  } else if (/^发送$|^send$/i.test(text)) {
    score += 25;
    reasons.push('send_text');
  } else if (/send|submit/.test(String(candidate.className || '').toLowerCase())) {
    score += 15;
    reasons.push('class_send');
  } else {
    score -= 10;
    rejectReasons.push('not_send_text');
  }

  if (BLOCKED_BUTTON_RE.test(text)) {
    score -= 50;
    rejectReasons.push('blocked_button_text');
  }

  if (vh > 0 && rect.y > vh * 0.55) {
    score += 15;
    reasons.push('bottom_area');
  }

  if (editorRect.width > 0) {
    const dy = Math.abs(rect.y - editorRect.y);
    const dx = Math.abs(rect.x - (editorRect.x + editorRect.width));
    if (dy < 120 && dx < 400) {
      score += 20;
      reasons.push('near_editor');
    }
  }

  if (candidate.disabled || candidate.sendButtonEnabled === false) {
    score -= 5;
    reasons.push('disabled');
  }

  const trusted = score >= SEND_BUTTON_TRUST_SCORE && rejectReasons.length === 0;
  return {
    score,
    reasons,
    rejectReasons,
    trusted,
    sendButtonFound: trusted,
    sendButtonConfidence: Math.min(100, Math.max(score, 0)),
    sendButtonEnabled: candidate.disabled !== true && candidate.sendButtonEnabled !== false,
  };
}

function analyzeReplyEditorInspection(payload = {}) {
  const viewport = payload.viewport || {};
  const editors = Array.isArray(payload.editorCandidates) ? payload.editorCandidates : [];
  const buttons = Array.isArray(payload.sendButtonCandidates) ? payload.sendButtonCandidates : [];

  const scoredEditors = editors.map((e) => ({
    ...e,
    ...scoreEditorCandidate(e, viewport),
  }));
  scoredEditors.sort((a, b) => (b.score || 0) - (a.score || 0));
  const bestEditor = scoredEditors.find((e) => e.trusted) || scoredEditors[0] || null;

  const scoredButtons = buttons.map((b) => ({
    ...b,
    ...scoreSendButtonCandidate(b, bestEditor || {}, viewport),
  }));
  scoredButtons.sort((a, b) => (b.score || 0) - (a.score || 0));
  const bestButton = scoredButtons.find((b) => b.trusted) || scoredButtons[0] || null;

  return {
    editorFound: Boolean(bestEditor && bestEditor.trusted),
    editorSelectorPath: bestEditor?.selectorPath || '',
    editorType: bestEditor?.editorType || 'unknown',
    editorRect: bestEditor?.rect || {},
    editorTextBefore: bestEditor?.editorTextBefore || '',
    editorConfidence: bestEditor?.editorConfidence || 0,
    editorRejectReasons: bestEditor?.rejectReasons || [],
    sendButtonFound: Boolean(bestButton && bestButton.trusted),
    sendButtonSelectorPath: bestButton?.selectorPath || '',
    sendButtonText: bestButton?.text || bestButton?.sendButtonText || '',
    sendButtonEnabled: bestButton?.sendButtonEnabled !== false,
    sendButtonRect: bestButton?.rect || {},
    sendButtonConfidence: bestButton?.sendButtonConfidence || 0,
    sendButtonRejectReasons: bestButton?.rejectReasons || [],
    bestEditor,
    bestSendButton: bestButton,
  };
}

function matchDraftToConversation(draft = {}, conversation = {}) {
  const draftShopId = String(draft.shop_id || draft.shopId || '').trim();
  const convShopId = String(conversation.shopId || conversation.shop_id || '').trim();
  const draftBuyerId = String(draft.buyer_id || draft.buyerId || '').trim();
  const convBuyerId = String(conversation.buyerId || conversation.buyer_id || '').trim();
  const draftConvId = String(draft.conversation_id || draft.conversationId || '').trim();
  const convConvId = String(conversation.conversationId || conversation.conversation_id || '').trim();

  const shopMatched = Boolean(draftShopId && convShopId && draftShopId === convShopId);
  const buyerMatched = Boolean(draftBuyerId && convBuyerId && draftBuyerId === convBuyerId);
  let conversationMatched = false;
  if (draftConvId && convConvId && draftConvId === convConvId) {
    conversationMatched = true;
  } else if (buyerMatched && /^doudian:/.test(draftConvId)) {
    conversationMatched = true;
  } else if (buyerMatched && !draftConvId) {
    conversationMatched = true;
  }

  return {
    shopMatched,
    buyerMatched,
    conversationMatched,
    matched: shopMatched && buyerMatched && conversationMatched,
  };
}

module.exports = {
  EDITOR_TRUST_SCORE,
  SEND_BUTTON_TRUST_SCORE,
  EDITOR_CONFIDENCE_THRESHOLD,
  scoreEditorCandidate,
  scoreSendButtonCandidate,
  analyzeReplyEditorInspection,
  matchDraftToConversation,
};
