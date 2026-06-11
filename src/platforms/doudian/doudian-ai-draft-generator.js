const { isHistoryUiText } = require('./doudian-history-validation');
const { normalizeDirection } = require('./doudian-chat-history-utils');

const GREETING_PATTERNS = [/在吗/, /你好/, /在不在/, /转人工/];
const STOCK_PATTERNS = [/还有货/, /有货吗/, /有没有货/, /库存/];
const PRICE_PATTERNS = [/多少钱/, /什么价/, /价格/, /多少元/, /¥/, /几块/];

const RISK_PHRASE_PATTERNS = [
  /我已经帮你退款/,
  /我已经同意售后/,
  /我已经发货/,
  /我保证/,
  /百分百/,
  /假一赔十/,
  /平台一定/,
  /马上到账/,
];

const DEFAULT_DRAFT =
  '亲亲，在的，请问您这边需要咨询哪方面的问题？我帮您看一下。';

const DRAFT_TEMPLATES = {
  greeting:
    '亲亲，在的，请问您看中哪一款，或者有什么问题可以直接发我，我帮您看一下。',
  stock:
    '亲亲，在的，您把想看的款式或者截图发我，我帮您确认一下库存和圈口。',
  price:
    '亲亲，价格以您当前看到的商品页面为准，如果您想看同价位或者更合适的款式，我也可以帮您推荐。',
  fallback: DEFAULT_DRAFT,
};

function normalizeMessageText(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .trim();
}

function isContextMessageUsable(message = {}) {
  const text = String(message.text || '').trim();
  if (!text || text.length < 1) return false;
  if (isHistoryUiText(text)) return false;
  const direction = normalizeDirection(message.direction);
  if (direction === 'unknown') return false;
  return true;
}

function buildDraftContext(conversation = {}, messages = []) {
  const usable = messages
    .filter(isContextMessageUsable)
    .map((m) => ({
      direction: normalizeDirection(m.direction),
      messageType: m.messageType || m.message_type || 'text',
      text: String(m.text || '').slice(0, 500),
      timestamp: Number(m.timestamp || m.message_timestamp || m.created_at || 0),
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-20);

  return {
    platform: conversation.platform || 'doudian',
    shopId: conversation.shopId || conversation.shop_id || '',
    shopName: conversation.shopName || conversation.shop_name || '',
    conversationId: conversation.conversationId || conversation.conversation_id || '',
    buyerId: conversation.buyerId || conversation.buyer_id || '',
    buyerName: conversation.buyerName || conversation.buyer_name || '',
    messages: usable,
  };
}

function findLastBuyerMessage(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (normalizeDirection(m.direction) === 'buyer') {
      return m;
    }
  }
  return null;
}

function classifyBuyerIntent(text) {
  const t = normalizeMessageText(text);
  if (!t) return 'fallback';
  if (GREETING_PATTERNS.some((re) => re.test(t))) return 'greeting';
  if (STOCK_PATTERNS.some((re) => re.test(t))) return 'stock';
  if (PRICE_PATTERNS.some((re) => re.test(t))) return 'price';
  return 'fallback';
}

function scanDraftRisk(draftText = '') {
  const text = String(draftText || '');
  for (const re of RISK_PHRASE_PATTERNS) {
    if (re.test(text)) {
      return { riskLevel: 'high', matched: re.source };
    }
  }
  return { riskLevel: 'low', matched: '' };
}

function needsCustomerReply(messages = []) {
  if (!messages.length) return false;
  const last = messages[messages.length - 1];
  return normalizeDirection(last.direction) === 'buyer';
}

function generateDraftFromContext(context = {}) {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const lastBuyer = findLastBuyerMessage(messages);

  if (!messages.length) {
    return {
      ok: false,
      reason: 'no_conversation_messages',
      context,
    };
  }

  if (!lastBuyer) {
    return {
      ok: false,
      reason: 'no_buyer_message',
      context,
      messageCount: messages.length,
    };
  }

  if (!needsCustomerReply(messages)) {
    return {
      ok: false,
      reason: 'no_reply_needed',
      context,
      messageCount: messages.length,
      lastBuyerMessage: lastBuyer.text,
    };
  }

  const intent = classifyBuyerIntent(lastBuyer.text);
  const draftText = DRAFT_TEMPLATES[intent] || DRAFT_TEMPLATES.fallback;
  const risk = scanDraftRisk(draftText);
  const status = risk.riskLevel === 'high' ? 'risk_blocked' : 'draft_only';

  return {
    ok: risk.riskLevel !== 'high',
    reason: risk.riskLevel === 'high' ? 'risk_blocked' : 'draft_generated',
    context,
    messageCount: messages.length,
    lastBuyerMessage: lastBuyer.text,
    draftText,
    draftReason: intent,
    riskLevel: risk.riskLevel,
    status,
    riskMatched: risk.matched,
  };
}

module.exports = {
  GREETING_PATTERNS,
  STOCK_PATTERNS,
  PRICE_PATTERNS,
  RISK_PHRASE_PATTERNS,
  DRAFT_TEMPLATES,
  buildDraftContext,
  findLastBuyerMessage,
  classifyBuyerIntent,
  scanDraftRisk,
  needsCustomerReply,
  generateDraftFromContext,
  isContextMessageUsable,
};
