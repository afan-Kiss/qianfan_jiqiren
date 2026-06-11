const { getDoudianConfig } = require('../../shared/config');
const { isUiNoise, normalizeText } = require('./doudian-ui-noise-filter');
const { pickFirst } = require('./doudian-shop-utils');
const { DIRECTION_CONFIDENCE_THRESHOLD } = require('./doudian-direction-resolver');

const BLOCKED_SHOP_IDS = new Set(['213196845']);

const BLOCKED_BUYER_NAMES = new Set([
  '个人短语',
  '团队短语',
  '快捷短语',
  '接待工具',
  '添加备注',
  '客户资料',
  '商家后台',
  'AI智能客服',
  '当前会话',
  '最近联系',
  '在线',
  '三方',
  '更多',
  '店铺消费',
  '抖音-商品详情页',
  '飞鸽客服系统',
  '实时',
  '消息',
  '会话',
  '搜索',
]);

const UI_HISTORY_TEXT_PATTERNS = [
  /拖拽到此发送/i,
  /添加备注/i,
  /店铺消费/i,
  /抖音-商品详情页/i,
  /^更多$/,
  /个人短语/,
  /团队短语/,
  /快捷短语/,
  /接待工具/,
  /客户资料/,
  /客户画像/,
  /商品详情/,
  /自营旗舰店/,
  /^发送$/,
  /^确定$/,
  /^取消$/,
  /^图片$/,
  /^表情$/,
  /^订单$/,
  /^售后$/,
];

const SIDE_PANEL_AREAS = new Set([
  'customerProfileArea',
  'quickPhraseArea',
  'orderCardArea',
  'inputArea',
  'unknownArea',
]);

function getKnownShopIds(knownShops) {
  const shops = knownShops || getDoudianConfig().knownShops || [];
  return new Set(shops.map((s) => String(s.shopId)).filter(Boolean));
}

function isBlockedBuyerName(name) {
  const n = normalizeText(name);
  if (!n) return false;
  if (BLOCKED_BUYER_NAMES.has(n)) return true;
  for (const p of UI_HISTORY_TEXT_PATTERNS) {
    if (p.test(n)) return true;
  }
  return false;
}

function isValidTrustedBuyerName(name) {
  const n = normalizeText(name);
  if (!n || n.length <= 1) return false;
  return !isBlockedBuyerName(n);
}

function isHistoryUiText(text) {
  const s = normalizeText(text);
  if (!s) return true;
  if (isUiNoise(s)) return true;
  for (const p of UI_HISTORY_TEXT_PATTERNS) {
    if (p.test(s)) return true;
  }
  return false;
}

function hasConversationIdentity(message = {}) {
  const conversationId = pickFirst(message.conversationId);
  const buyerId = pickFirst(message.buyerId);
  const buyerName = pickFirst(message.buyerName);
  return Boolean(
    conversationId ||
      buyerId ||
      isValidTrustedBuyerName(buyerName)
  );
}

function isDirectionTrusted(message = {}, context = {}) {
  const direction = String(message.direction || '').toLowerCase();
  const messageId = pickFirst(message.messageId);
  const conversationId = pickFirst(message.conversationId, context.conversationId);
  const buyerId = pickFirst(message.buyerId, context.buyerId);
  const directionConfidence = Number(message.directionConfidence || 0);

  if (direction === 'buyer' || direction === 'seller') {
    if (directionConfidence >= DIRECTION_CONFIDENCE_THRESHOLD || directionConfidence === 0) {
      return true;
    }
  }

  if (messageId && conversationId) return true;

  if (
    (direction === 'buyer' || direction === 'seller') &&
    directionConfidence >= DIRECTION_CONFIDENCE_THRESHOLD &&
    buyerId &&
    conversationId &&
    context.messageAreaTrusted !== false &&
    context.bubbleTrusted !== false
  ) {
    return true;
  }

  return false;
}

function validateDoudianMessageBeforeInsert(message = {}, context = {}) {
  const knownShopIds = context.knownShopIds || getKnownShopIds(context.knownShops);
  const activeShopId = String(context.activeShopId || '').trim();
  const shopId = String(message.shopId || '').trim();
  const source = String(message.source || '').trim();
  const domArea = String(message.domArea || context.domArea || 'chatBubbleArea').trim();

  const checks = {
    shopIdKnown: false,
    shopIdMatchesActiveShop: false,
    notUiNoise: false,
    notSidePanel: false,
    hasConversationIdentity: false,
    hasUsefulText: false,
    directionTrusted: false,
  };

  checks.shopIdKnown = Boolean(shopId && knownShopIds.has(shopId) && !BLOCKED_SHOP_IDS.has(shopId));
  checks.shopIdMatchesActiveShop = Boolean(
    activeShopId && shopId && shopId === activeShopId
  );
  checks.notUiNoise = !isHistoryUiText(message.text);
  checks.notSidePanel = source !== 'dom' || (domArea === 'chatBubbleArea' && !SIDE_PANEL_AREAS.has(domArea));
  checks.hasConversationIdentity = hasConversationIdentity(message, context);
  checks.hasUsefulText = normalizeText(message.text).length >= 2;
  checks.directionTrusted = isDirectionTrusted(message, {
    ...context,
    conversationId: pickFirst(message.conversationId, context.conversationId),
    buyerId: pickFirst(message.buyerId, context.buyerId),
  });

  let rejectReason = '';
  if (BLOCKED_SHOP_IDS.has(shopId) || (shopId && !knownShopIds.has(shopId))) {
    rejectReason = 'shop_id_not_in_known_shops';
  } else if (activeShopId && shopId && shopId !== activeShopId) {
    rejectReason = 'shop_id_not_active_shop';
  } else if (source === 'dom' && domArea !== 'chatBubbleArea') {
    rejectReason = 'side_panel_dom_candidate';
  } else if (!checks.notUiNoise) {
    rejectReason = 'history_ui_noise_text';
  } else if (!checks.hasConversationIdentity) {
    rejectReason = 'missing_conversation_identity';
  } else if (!checks.directionTrusted) {
    rejectReason = 'unknown_direction_without_identity';
  } else if (!checks.hasUsefulText) {
    rejectReason = 'empty_or_short_text';
  } else if (!checks.shopIdKnown) {
    rejectReason = 'shop_id_unknown';
  } else if (!checks.shopIdMatchesActiveShop) {
    rejectReason = 'shop_id_not_active_shop';
  }

  const ok = Object.values(checks).every(Boolean);
  return { ok, rejectReason: ok ? '' : rejectReason, checks };
}

function evaluateConversationSelection(fields = {}) {
  const buyerName = pickFirst(fields.buyerName);
  if (isBlockedBuyerName(buyerName)) {
    return {
      selectedConversationDetected: false,
      conversationTrusted: false,
      uiNoiseBuyerNameDetected: true,
      reason: 'selected_conversation_name_is_ui_noise',
    };
  }

  const conversationId = pickFirst(fields.conversationId);
  const buyerId = pickFirst(fields.buyerId);
  const trustedName = isValidTrustedBuyerName(buyerName);

  const selected = Boolean(conversationId || buyerId || trustedName);
  return {
    selectedConversationDetected: selected,
    conversationTrusted: selected,
    uiNoiseBuyerNameDetected: false,
    reason: selected ? '' : '',
  };
}

function evaluateHistoryTrust(report = {}) {
  const activeImShopCount = Number(report.activeImShopCount || report.activeImShops?.length || 0);
  const validatedCount = Number(report.validatedMessageCount || 0);
  const hasValidated = validatedCount > 0;
  const hasInsert =
    Number(report.insertedMessageCount || 0) > 0 || Number(report.dedupeHitCount || 0) > 0;

  const directionStats = report.directionStats || {
    buyer: Number(report.realBuyerMessageCount || 0),
    seller: Number(report.sellerMessageCount || 0),
    unknown: 0,
  };
  const resolvedDirections = Number(directionStats.buyer || 0) + Number(directionStats.seller || 0);
  const unknownDirections = Number(directionStats.unknown || 0);
  const trustedDirections = resolvedDirections > 0 && unknownDirections < validatedCount;

  const hasIdentity = Boolean(
    report.conversationId ||
      report.buyerId ||
      isValidTrustedBuyerName(report.buyerName)
  );
  const hasConversationId = Boolean(report.conversationId);

  const conversationTrusted =
    Boolean(report.conversationTrusted) ||
    (hasIdentity && !report.uiNoiseBuyerNameDetected && report.selectedConversationDetected);

  let historyTrusted =
    Number(report.imBridgeSeen || 0) > 0 &&
    report.shopReportValid !== false &&
    activeImShopCount >= 1 &&
    conversationTrusted &&
    hasValidated &&
    hasInsert &&
    trustedDirections &&
    hasConversationId &&
    Number(report.wrongShopCandidateCount || 0) === 0;

  let reason = '';
  if (Number(report.wrongShopCandidateCount || 0) > 0) {
    reason = 'history_candidates_wrong_shop';
    historyTrusted = false;
  } else if (hasValidated && resolvedDirections === 0) {
    reason = 'history_direction_not_resolved';
    historyTrusted = false;
  } else if (Number(report.historyMessageCount || 0) > 0 && !historyTrusted) {
    reason = 'history_candidates_untrusted';
  } else if (historyTrusted) {
    reason = report.isMock ? 'mock_chat_history_pipeline_ok' : 'chat_history_captured';
  }

  return { conversationTrusted, historyTrusted, reason, trustedDirections, directionStats };
}

module.exports = {
  BLOCKED_SHOP_IDS,
  BLOCKED_BUYER_NAMES,
  UI_HISTORY_TEXT_PATTERNS,
  SIDE_PANEL_AREAS,
  getKnownShopIds,
  isBlockedBuyerName,
  isValidTrustedBuyerName,
  isHistoryUiText,
  hasConversationIdentity,
  isDirectionTrusted,
  validateDoudianMessageBeforeInsert,
  evaluateConversationSelection,
  evaluateHistoryTrust,
};
