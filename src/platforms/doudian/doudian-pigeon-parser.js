const { getDoudianConfig } = require('../../shared/config');
const { isUiNoise } = require('./doudian-ui-noise-filter');
const { hashText } = require('./doudian-shop-utils');

const SKIP_KEY_RE =
  /cookie|token|csrf|authorization|ticket|sign|x-ms-token|bd-ticket|session-sign|password|secret/i;

const FIELD_ALIASES = {
  shopId: ['shopId', 'shop_id'],
  shopName: ['shopName', 'shop_name'],
  accountId: ['accountId', 'account_id'],
  sessionPartitionKey: ['sessionPartitionKey', 'session_partition_key', 'partitionKey'],
  conversationId: ['conversationId', 'conversation_id', 'conversation_short_id'],
  buyerId: ['buyerId', 'buyer_id', 'userId', 'user_id', 'customerId', 'customer_id', 'uid'],
  buyerName: ['buyerName', 'nickName', 'nickname', 'name', 'userName', 'user_name'],
  messageId: ['messageId', 'message_id', 'serverMessageId', 'msgId', 'msg_id'],
  text: ['content', 'text', 'msg', 'message', 'lastMessage', 'last_message'],
  timestamp: ['sendTime', 'createTime', 'timestamp', 'lastMessageTime', 'last_message_time', 'msgTime'],
  unreadCount: ['unread', 'unreadCount', 'unread_count'],
  status: ['status', 'conversationStatus', 'conversation_status', 'state'],
  senderRole: ['senderRole', 'fromRole', 'role', 'sender_role', 'from_role', 'senderType', 'sender_type'],
};

const MAX_DEPTH = 6;
const MAX_NODES = 3000;
const MAX_FIELD_LEN = 1000;
const MAX_SAFE_PAYLOAD_BYTES = 120000;

function pickField(obj, names) {
  if (!obj || typeof obj !== 'object') return '';
  for (const n of names) {
    const v = obj[n];
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number') return String(v).slice(0, MAX_FIELD_LEN);
  }
  return '';
}

function pickNumber(obj, names) {
  const s = pickField(obj, names);
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function resolveApiName(urlOrKey = '') {
  const u = String(urlOrKey).toLowerCase();
  if (u.includes('currentuser')) return 'currentuser';
  if (u.includes('get_current_conversation_list')) return 'get_current_conversation_list';
  if (u.includes('get_link_info')) return 'get_link_info';
  if (u.includes('pigeon')) return 'pigeon';
  if (u.includes('history')) return 'history';
  if (u.includes('conversation')) return 'conversation';
  if (u.includes('message') || u.includes('msg_list') || u.includes('msglist')) return 'message';
  if (u.includes('chat')) return 'chat';
  if (u.includes('im')) return 'im';
  return 'unknown';
}

function isHistoryMemoryCacheKey(cacheKeyOrUrl = '') {
  const k = String(cacheKeyOrUrl).toLowerCase();
  if (!k) return false;
  return /get_link_info|get_current_conversation_list|message|history|chat|conversation|im|pigeon|msg_list|msglist|detail/.test(
    k
  );
}

function buildMemoryHistoryCandidate(payload, shopInfo = {}, meta = {}) {
  const cacheKey = meta.cacheKey || meta.url || '';
  if (!isHistoryMemoryCacheKey(cacheKey) && !meta.force) {
    const parsedProbe = parseChatHistoryPayload(payload, shopInfo, meta);
    if (!parsedProbe.messages.length) return null;
  }

  const parsed = parseChatHistoryPayload(payload, shopInfo, {
    ...meta,
    cacheKey,
    url: cacheKey,
  });

  if (!parsed.messages.length && !parsed.conversationId && !parsed.buyerId) return null;

  return {
    source: 'memory_cache',
    apiName: parsed.apiName || resolveApiName(cacheKey),
    cacheKey,
    shopInfo: {
      shopId: shopInfo.shopId || '',
      shopName: shopInfo.shopName || '',
      sessionPartitionKey: shopInfo.sessionPartitionKey || '',
      accountId: shopInfo.accountId || '',
    },
    conversationId: pickFirst(parsed.conversationId, meta.conversationId),
    buyerId: pickFirst(parsed.buyerId, meta.buyerId),
    buyerName: pickFirst(parsed.buyerName, meta.buyerName),
    messageCount: parsed.messages.length,
    items: parsed.messages,
  };
}

function shallowScan(obj, depth, counter, bag) {
  if (!obj || depth > MAX_DEPTH || counter.n > MAX_NODES) return;
  counter.n += 1;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length && i < 50; i++) shallowScan(obj[i], depth + 1, counter, bag);
    return;
  }
  if (typeof obj !== 'object') return;

  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const val = pickField(obj, aliases);
    if (val && !bag[field]) bag[field] = val;
  }

  for (const key of Object.keys(obj)) {
    if (SKIP_KEY_RE.test(key)) continue;
    const val = obj[key];
    if (val && typeof val === 'object') shallowScan(val, depth + 1, counter, bag);
  }
}

function sanitizePayload(obj, depth = 0, counter = { n: 0 }) {
  if (!obj || depth > MAX_DEPTH || counter.n > MAX_NODES) return null;
  counter.n += 1;

  if (Array.isArray(obj)) {
    return obj.slice(0, 100).map((item) => sanitizePayload(item, depth + 1, counter));
  }

  if (typeof obj !== 'object') {
    if (typeof obj === 'string') return obj.slice(0, MAX_FIELD_LEN);
    if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
    return null;
  }

  const out = {};
  for (const key of Object.keys(obj)) {
    if (SKIP_KEY_RE.test(key)) continue;
    const val = obj[key];
    if (val == null) continue;
    if (typeof val === 'string') {
      out[key] = val.slice(0, MAX_FIELD_LEN);
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      out[key] = val;
    } else if (typeof val === 'object') {
      const child = sanitizePayload(val, depth + 1, counter);
      if (child != null) out[key] = child;
    }
  }
  return out;
}

function serializeSafePayload(payload) {
  const data = typeof payload === 'string' ? safeJsonParse(payload) : payload;
  if (!data) return '';
  const safe = sanitizePayload(data);
  if (!safe) return '';
  let s = JSON.stringify(safe);
  if (s.length > MAX_SAFE_PAYLOAD_BYTES) s = s.slice(0, MAX_SAFE_PAYLOAD_BYTES);
  return s;
}

function findConversationArrays(payload) {
  const arrays = [];
  const counter = { n: 0 };

  function walk(obj, depth) {
    if (!obj || depth > MAX_DEPTH || counter.n > MAX_NODES) return;
    counter.n += 1;
    if (Array.isArray(obj)) {
      if (obj.length > 0 && obj.some((item) => item && typeof item === 'object')) {
        const hasConv = obj.some(
          (item) =>
            pickField(item, FIELD_ALIASES.conversationId) ||
            pickField(item, FIELD_ALIASES.buyerId) ||
            pickField(item, FIELD_ALIASES.buyerName)
        );
        if (hasConv) arrays.push(obj);
      }
      for (const item of obj.slice(0, 30)) walk(item, depth + 1);
      return;
    }
    if (typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        if (SKIP_KEY_RE.test(key)) continue;
        walk(obj[key], depth + 1);
      }
    }
  }

  walk(payload, 0);
  return arrays;
}

function normalizeConversation(item, shopInfo = {}) {
  const text = pickField(item, FIELD_ALIASES.text);
  const conversationId = pickField(item, FIELD_ALIASES.conversationId);
  const buyerId = pickField(item, FIELD_ALIASES.buyerId);
  const buyerName = pickField(item, FIELD_ALIASES.buyerName);
  if (!conversationId && !buyerId && !buyerName) return null;

  const lastMessageText = text && !isUiNoise(text) ? text.slice(0, MAX_FIELD_LEN) : '';
  const lastMessageTime = pickNumber(item, FIELD_ALIASES.timestamp);

  return {
    conversationId,
    buyerId,
    buyerName: buyerName.slice(0, 200),
    lastMessageText,
    lastMessageTime,
    unreadCount: pickNumber(item, FIELD_ALIASES.unreadCount),
    status: pickField(item, FIELD_ALIASES.status),
    rawTextHash: hashText(lastMessageText || buyerName || conversationId),
    shopId: pickField(item, FIELD_ALIASES.shopId) || shopInfo.shopId || '',
    shopName: pickField(item, FIELD_ALIASES.shopName) || shopInfo.shopName || '',
  };
}

function inferDirection(item) {
  const isSelf = item.isSelf ?? item.is_self ?? item.isSeller ?? item.is_seller;
  if (isSelf === true || isSelf === 1 || isSelf === '1' || isSelf === 'true') return 'seller';
  if (isSelf === false || isSelf === 0 || isSelf === '0' || isSelf === 'false') return 'buyer';

  const role = pickField(item, FIELD_ALIASES.senderRole);
  const lower = role.toLowerCase();
  if (/buyer|customer|user|inbound|receive|guest/.test(lower)) return 'buyer';
  if (/seller|shop|service|outbound|send|staff|kefu/.test(lower)) return 'seller';

  const raw = pickField(item, ['direction', 'msgDirection', 'msg_direction']);
  const dLower = raw.toLowerCase();
  if (/buyer|customer|user|inbound|receive/.test(dLower)) return 'buyer';
  if (/seller|shop|service|outbound|send/.test(dLower)) return 'seller';
  return 'unknown';
}

function inferMessageType(item, text) {
  const raw = pickField(item, ['messageType', 'message_type', 'msgType', 'msg_type', 'type', 'contentType']);
  const lower = raw.toLowerCase();
  if (/image|pic|img/.test(lower)) return 'image';
  if (/order/.test(lower)) return 'order_card';
  if (/aftersale|refund/.test(lower)) return 'aftersale_card';
  if (text) return 'text';
  return lower ? lower.slice(0, 32) : 'unknown';
}

function normalizeMessage(item, shopInfo = {}) {
  const text = pickField(item, FIELD_ALIASES.text);
  const messageId = pickField(item, FIELD_ALIASES.messageId);
  const conversationId = pickField(item, FIELD_ALIASES.conversationId);
  const buyerId = pickField(item, FIELD_ALIASES.buyerId);
  if (!messageId && !conversationId && !buyerId) return null;
  if (text && isUiNoise(text)) return null;

  const normalizedText = text ? text.slice(0, MAX_FIELD_LEN) : '';
  const timestamp = pickNumber(item, FIELD_ALIASES.timestamp) || Date.now();

  return {
    conversationId,
    buyerId,
    buyerName: pickField(item, FIELD_ALIASES.buyerName).slice(0, 200),
    messageId,
    direction: inferDirection(item),
    messageType: inferMessageType(item, normalizedText),
    text: normalizedText,
    timestamp,
    rawTextHash: hashText(normalizedText || messageId),
    shopId: pickField(item, FIELD_ALIASES.shopId) || shopInfo.shopId || '',
    shopName: pickField(item, FIELD_ALIASES.shopName) || shopInfo.shopName || '',
  };
}

function extractConversations(payload, shopInfo = {}) {
  const seen = new Set();
  const conversations = [];

  const arrays = findConversationArrays(payload);
  if (Array.isArray(payload) && !arrays.includes(payload)) arrays.unshift(payload);

  for (const arr of arrays) {
    for (const item of arr.slice(0, 100)) {
      const conv = normalizeConversation(item, shopInfo);
      if (!conv) continue;
      const key = conv.conversationId || `${conv.buyerId}:${conv.buyerName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      conversations.push(conv);
    }
  }

  return conversations.slice(0, 100);
}

function findMessageArrays(payload) {
  const arrays = [];
  const counter = { n: 0 };

  function looksLikeMessageArray(arr) {
    if (!Array.isArray(arr) || !arr.length) return false;
    return arr.some(
      (item) =>
        item &&
        typeof item === 'object' &&
        (pickField(item, FIELD_ALIASES.messageId) ||
          pickField(item, FIELD_ALIASES.text) ||
          pickField(item, FIELD_ALIASES.conversationId))
    );
  }

  function walk(obj, depth, keyHint) {
    if (!obj || depth > MAX_DEPTH || counter.n > MAX_NODES) return;
    counter.n += 1;
    if (Array.isArray(obj)) {
      if (looksLikeMessageArray(obj)) arrays.push(obj);
      for (const item of obj.slice(0, 30)) walk(item, depth + 1, keyHint);
      return;
    }
    if (typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        if (SKIP_KEY_RE.test(key)) continue;
        const lower = key.toLowerCase();
        if (/message|history|msg_list|msglist|chat_list|detail/.test(lower)) {
          const val = obj[key];
          if (Array.isArray(val) && looksLikeMessageArray(val)) arrays.push(val);
        }
        walk(obj[key], depth + 1, key);
      }
    }
  }

  walk(payload, 0, '');
  return arrays;
}

function extractLinkInfo(payload) {
  const data = typeof payload === 'string' ? safeJsonParse(payload) : payload;
  if (!data) return { conversationId: '', buyerId: '', buyerName: '' };

  const bag = {};
  shallowScan(data, 0, { n: 0 }, bag);

  let link = data.link_info || data.data?.link_info || data.data?.linkInfo;
  if (!link && data.data && typeof data.data === 'object') {
    link = data.data;
  }

  const conversationId = pickField(link || bag, FIELD_ALIASES.conversationId) || bag.conversationId || '';
  const buyerId = pickField(link || bag, FIELD_ALIASES.buyerId) || bag.buyerId || '';
  const buyerName = pickField(link || bag, FIELD_ALIASES.buyerName) || bag.buyerName || '';

  return { conversationId, buyerId, buyerName };
}

function parseChatHistoryPayload(payload, shopInfo = {}, meta = {}) {
  const apiName = resolveApiName(meta.url || meta.cacheKey || '');
  const data = typeof payload === 'string' ? safeJsonParse(payload) : payload;

  if (!data) {
    return {
      ok: false,
      apiName,
      conversationId: '',
      buyerId: '',
      buyerName: '',
      messages: [],
      messageCount: 0,
    };
  }

  const link = apiName === 'get_link_info' ? extractLinkInfo(data) : { conversationId: '', buyerId: '', buyerName: '' };
  const bag = {};
  shallowScan(data, 0, { n: 0 }, bag);

  const conversationId = pickFirst(link.conversationId, bag.conversationId, meta.conversationId);
  const buyerId = pickFirst(link.buyerId, bag.buyerId, meta.buyerId);
  const buyerName = pickFirst(link.buyerName, bag.buyerName, meta.buyerName);

  const messages = [];
  const seen = new Set();
  const arrays = findMessageArrays(data);
  if (Array.isArray(data.messages) && !arrays.includes(data.messages)) arrays.unshift(data.messages);
  if (Array.isArray(data.data?.messages) && !arrays.includes(data.data.messages)) arrays.unshift(data.data.messages);
  if (Array.isArray(data.list) && !arrays.includes(data.list)) arrays.unshift(data.list);

  for (const arr of arrays) {
    for (const item of arr.slice(0, 200)) {
      const msg = normalizeMessage(item, shopInfo);
      if (!msg) continue;
      const key = msg.messageId || `${msg.conversationId}:${msg.rawTextHash}:${msg.timestamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!msg.conversationId && conversationId) msg.conversationId = conversationId;
      if (!msg.buyerId && buyerId) msg.buyerId = buyerId;
      if (!msg.buyerName && buyerName) msg.buyerName = buyerName;
      messages.push(msg);
    }
  }

  return {
    ok: true,
    apiName,
    conversationId,
    buyerId,
    buyerName,
    messages,
    messageCount: messages.length,
  };
}

function pickFirst(...vals) {
  for (const v of vals) {
    const s = String(v || '').trim();
    if (s) return s;
  }
  return '';
}

function extractMessages(payload, shopInfo = {}) {
  const messages = [];
  const seen = new Set();
  const counter = { n: 0 };

  function walk(obj, depth) {
    if (!obj || depth > MAX_DEPTH || counter.n > MAX_NODES) return;
    counter.n += 1;
    if (Array.isArray(obj)) {
      for (const item of obj.slice(0, 100)) {
        const msg = normalizeMessage(item, shopInfo);
        if (!msg) {
          walk(item, depth + 1);
          continue;
        }
        const key = msg.messageId || `${msg.conversationId}:${msg.rawTextHash}:${msg.timestamp}`;
        if (seen.has(key)) continue;
        seen.add(key);
        messages.push(msg);
        walk(item, depth + 1);
      }
      return;
    }
    if (typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        if (SKIP_KEY_RE.test(key)) continue;
        walk(obj[key], depth + 1);
      }
    }
  }

  walk(payload, 0);
  return messages.slice(0, 100);
}

function buildEmptyState(apiName, conversations, messages) {
  if (apiName === 'get_current_conversation_list' && conversations.length === 0) {
    return { isEmpty: true, reason: 'conversation_list_empty' };
  }
  if (conversations.length === 0 && messages.length === 0 && apiName === 'get_link_info') {
    return { isEmpty: false, reason: '' };
  }
  return { isEmpty: false, reason: '' };
}

function parsePigeonPayload(payload, meta = {}) {
  const apiName = resolveApiName(meta.url || meta.cacheKey || '');
  const data = typeof payload === 'string' ? safeJsonParse(payload) : payload;

  if (!data) {
    return {
      ok: false,
      apiName,
      shopInfo: { shopId: '', shopName: '', accountId: '', sessionPartitionKey: '' },
      conversations: [],
      messages: [],
      emptyState: { isEmpty: false, reason: '' },
      conversationCount: 0,
      messageCount: 0,
    };
  }

  const bag = {};
  shallowScan(data, 0, { n: 0 }, bag);

  const shopInfo = {
    shopId: bag.shopId || '',
    shopName: bag.shopName || '',
    accountId: bag.accountId || '',
    sessionPartitionKey: bag.sessionPartitionKey || meta.sessionPartitionKey || '',
  };
  applyKnownShops(shopInfo);

  const conversations = extractConversations(data, shopInfo);
  const messages = extractMessages(data, shopInfo).filter((m) => isRealMessageCandidate(m));
  const emptyState = buildEmptyState(apiName, conversations, messages);

  return {
    ok: true,
    apiName,
    shopInfo,
    conversations,
    messages,
    emptyState,
    conversationCount: conversations.length,
    messageCount: messages.length,
    rawBag: bag,
  };
}

function applyKnownShops(shopInfo) {
  const cfg = getDoudianConfig();
  const known = cfg.knownShops || [];
  if (shopInfo.shopId) return;
  const name = String(shopInfo.shopName || '');
  for (const ks of known) {
    if (name && (name.includes(ks.shopName) || ks.shopName.includes(name))) {
      shopInfo.shopId = ks.shopId;
      shopInfo.shopName = shopInfo.shopName || ks.shopName;
      break;
    }
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}

function isRealMessageCandidate(item = {}) {
  const text = String(item.text || item.content || '').trim();
  if (text && isUiNoise(text)) return false;
  if (item.messageId) return true;
  if (item.conversationId && text) return true;
  if (item.buyerId && text) return true;
  if (item.conversationId || item.buyerId) return Boolean(text);
  return false;
}

function createMockFixtures() {
  return {
    currentuser: {
      data: {
        shopId: '263636465',
        shopName: 'XY祥钰珠宝',
        accountId: 'acc_***01',
        sessionPartitionKey: 'persist:761***01',
      },
    },
    emptyConversationList: {
      data: { list: [], total: 0 },
    },
    conversationList: {
      data: {
        list: [
          {
            conversation_id: 'conv_mock_001',
            user_id: 'buyer_***88',
            nickname: '测试买家',
            last_message: '你好，请问这款还有货吗',
            unread_count: 1,
            status: 'active',
            sendTime: 1718000000000,
          },
        ],
      },
    },
    messagePayload: {
      data: {
        messages: [
          {
            message_id: 'msg_mock_001',
            conversation_id: 'conv_mock_001',
            user_id: 'buyer_***88',
            nickname: '测试买家',
            content: '你好，请问这款还有货吗',
            sendTime: 1718000000000,
            direction: 'buyer',
            msg_type: 'text',
          },
        ],
      },
    },
    chatHistory: {
      conversationId: 'conv_mock_hist_001',
      buyerId: 'buyer_***88',
      buyerName: '测试买家',
      messages: [
        {
          message_id: 'msg_hist_001',
          conversation_id: 'conv_mock_hist_001',
          uid: 'buyer_***88',
          nickname: '测试买家',
          content: '你好，在吗',
          sendTime: 1718000001000,
          senderRole: 'buyer',
          msg_type: 'text',
        },
        {
          message_id: 'msg_hist_002',
          conversation_id: 'conv_mock_hist_001',
          content: '在的，请问需要什么帮助',
          sendTime: 1718000002000,
          isSelf: true,
          msg_type: 'text',
        },
        {
          message_id: 'msg_hist_003',
          conversation_id: 'conv_mock_hist_001',
          uid: 'buyer_***88',
          content: '这款手镯还有货吗',
          sendTime: 1718000003000,
          direction: 'buyer',
          msg_type: 'text',
        },
      ],
    },
  };
}

module.exports = {
  resolveApiName,
  parsePigeonPayload,
  isRealMessageCandidate,
  sanitizePayload,
  serializeSafePayload,
  shallowScan,
  extractConversations,
  extractMessages,
  normalizeConversation,
  normalizeMessage,
  createMockFixtures,
  findMessageArrays,
  extractLinkInfo,
  parseChatHistoryPayload,
  isHistoryMemoryCacheKey,
  buildMemoryHistoryCandidate,
  MAX_DEPTH,
  MAX_NODES,
};
