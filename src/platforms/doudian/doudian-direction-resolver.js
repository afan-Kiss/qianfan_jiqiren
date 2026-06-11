const { normalizeDirection } = require('./doudian-chat-history-utils');

const SELLER_CLASS_RE =
  /self|mine|right|sender|service|seller|staff|kefu|outbound|send|is-self|from-self|merchant|shop-msg/i;
const BUYER_CLASS_RE =
  /left|buyer|user|customer|consumer|inbound|receive|guest|is-buyer|from-user|visitor/i;

const SELLER_PHRASE_RES = [
  /您好，现在是人工客服为您服务/,
  /亲亲，很高兴为您服务/,
  /请问需要什么帮助/,
  /在的，请问/,
  /客服.*为您服务/,
  /商家配置发送/,
  /为了更高效地帮您/,
  /查阅一下您和智能客服/,
  /饭饭接入/,
];

const BUYER_PHRASE_RES = [
  /^在在在$/,
  /^转人工$/,
  /^你好$/,
  /^5555$/,
  /^还有货吗/,
  /这款.*还有货/,
  /在吗/,
  /^你还敢$/,
];

const DIRECTION_CONFIDENCE_THRESHOLD = 60;

function normalizeClassHints(classHints) {
  if (!Array.isArray(classHints)) return [];
  return classHints.map((h) => String(h || '').trim()).filter(Boolean);
}

function resolveDirectionFromBubble(bubble = {}, areaContext = {}) {
  const rect = bubble.rect || {};
  const bubbleCenterX = Number(
    bubble.bubbleCenterX != null ? bubble.bubbleCenterX : (rect.x || 0) + (rect.width || 0) / 2
  );
  const messageAreaCenterX = Number(
    areaContext.messageAreaCenterX != null
      ? areaContext.messageAreaCenterX
      : bubble.messageAreaCenterX != null
        ? bubble.messageAreaCenterX
        : 0
  );
  const viewportWidth = Number(areaContext.viewportWidth || bubble.viewportWidth || 0);

  let directionGuess = normalizeDirection(bubble.directionGuess);
  let directionConfidence = Number(bubble.directionConfidence || 0);
  const directionReasons = Array.isArray(bubble.directionReasons) ? [...bubble.directionReasons] : [];
  const classHints = normalizeClassHints(bubble.classHints);

  let isLeftBubble = Boolean(bubble.isLeftBubble);
  let isRightBubble = Boolean(bubble.isRightBubble);
  let avatarSide = bubble.avatarSide || 'unknown';

  const centerX =
    messageAreaCenterX > 0
      ? messageAreaCenterX
      : viewportWidth > 0
        ? viewportWidth * 0.55
        : bubbleCenterX;

  if (bubbleCenterX > 0 && centerX > 0) {
    if (bubbleCenterX < centerX - 30) {
      isLeftBubble = true;
      if (directionGuess !== 'seller') directionGuess = 'buyer';
      directionConfidence += 35;
      directionReasons.push('position_left');
    } else if (bubbleCenterX > centerX + 30) {
      isRightBubble = true;
      if (directionGuess !== 'buyer') directionGuess = 'seller';
      directionConfidence += 35;
      directionReasons.push('position_right');
    }
  }

  const text = String(bubble.text || '').trim();
  const parentPath = String(bubble.parentSelectorPath || bubble.selectorPath || '').toLowerCase();
  const classChain = [
    String(bubble.className || ''),
    parentPath,
    ...classHints,
  ]
    .join(' ')
    .toLowerCase();

  for (const hint of classHints) {
    if (SELLER_CLASS_RE.test(hint)) {
      classHints.push(hint);
      if (directionGuess !== 'buyer') directionGuess = 'seller';
      directionConfidence += 20;
      directionReasons.push('class_seller');
    }
    if (BUYER_CLASS_RE.test(hint)) {
      classHints.push(hint);
      if (directionGuess !== 'seller') directionGuess = 'buyer';
      directionConfidence += 20;
      directionReasons.push('class_buyer');
    }
  }

  if (SELLER_CLASS_RE.test(classChain)) {
    if (directionGuess === 'unknown') directionGuess = 'seller';
    directionConfidence += 18;
    directionReasons.push('class_seller');
  }
  if (BUYER_CLASS_RE.test(classChain)) {
    if (directionGuess === 'unknown') directionGuess = 'buyer';
    directionConfidence += 18;
    directionReasons.push('class_buyer');
  }

  if (avatarSide === 'left') {
    if (directionGuess === 'unknown' || isLeftBubble) directionGuess = 'buyer';
    directionConfidence += 15;
    directionReasons.push('avatar_left');
  } else if (avatarSide === 'right') {
    if (directionGuess === 'unknown' || isRightBubble) directionGuess = 'seller';
    directionConfidence += 15;
    directionReasons.push('avatar_right');
  }

  for (const re of SELLER_PHRASE_RES) {
    if (re.test(text)) {
      directionGuess = 'seller';
      directionConfidence += 25;
      directionReasons.push('phrase_seller');
      break;
    }
  }
  for (const re of BUYER_PHRASE_RES) {
    if (re.test(text)) {
      directionGuess = 'buyer';
      directionConfidence += 25;
      directionReasons.push('phrase_buyer');
      break;
    }
  }

  directionGuess = normalizeDirection(directionGuess);
  directionConfidence = Math.min(100, Math.max(directionConfidence, directionGuess === 'unknown' ? 0 : 10));

  return {
    directionGuess,
    direction: directionGuess,
    directionConfidence,
    directionReasons: [...new Set(directionReasons)],
    bubbleCenterX: Math.round(bubbleCenterX),
    messageAreaCenterX: Math.round(centerX),
    isLeftBubble,
    isRightBubble,
    avatarSide,
    classHints: [...new Set(classHints)],
    directionTrusted: directionGuess !== 'unknown' && directionConfidence >= DIRECTION_CONFIDENCE_THRESHOLD,
  };
}

function computeDirectionStats(messages = []) {
  const stats = { buyer: 0, seller: 0, unknown: 0 };
  let confidenceSum = 0;
  let confidenceCount = 0;
  for (const msg of messages) {
    const d = normalizeDirection(msg.direction);
    if (d === 'buyer') stats.buyer += 1;
    else if (d === 'seller') stats.seller += 1;
    else stats.unknown += 1;
    if (Number(msg.directionConfidence || 0) > 0) {
      confidenceSum += Number(msg.directionConfidence);
      confidenceCount += 1;
    }
  }
  return {
    directionStats: stats,
    directionConfidenceAvg: confidenceCount ? Math.round(confidenceSum / confidenceCount) : 0,
  };
}

module.exports = {
  SELLER_CLASS_RE,
  BUYER_CLASS_RE,
  SELLER_PHRASE_RES,
  BUYER_PHRASE_RES,
  DIRECTION_CONFIDENCE_THRESHOLD,
  resolveDirectionFromBubble,
  computeDirectionStats,
};
