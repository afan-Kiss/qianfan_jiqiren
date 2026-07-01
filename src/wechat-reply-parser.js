/**
 * 解析二号微信引用回复 / #编号回复
 */
const fs = require('fs');
const path = require('path');
const config = require('./wechat/wxbot-new-config');
const { isAuthorizedReplyWxid, findNotifyTargetByRecipient } = config;
const { lookupSentNotificationForQuote, findPendingByReplyId } = require('./qianfan-data-store');

const REPLY_ID_PATTERN = /【千帆待回复\s*#(\d+)】/;
const NUMBER_REPLY_PATTERN = /^#?(\d{3,8})\s+([\s\S]+)$/;

function extractNoticeField(text, label) {
  const s = String(text || '');
  const withColon = s.match(new RegExp(`${label}[：:]\\s*([^\\n]+)`));
  if (withColon?.[1]) return withColon[1].trim();
  const withSpaces = s.match(new RegExp(`${label}\\s{2,}([^\\n]+)`));
  if (withSpaces?.[1]) return withSpaces[1].trim();
  const withSpace = s.match(new RegExp(`${label}\\s+([^\\n]+)`));
  if (withSpace?.[1]) return withSpace[1].trim();
  return '';
}

function parseReplyIdFromText(text) {
  const s = String(text || '');
  let m = s.match(REPLY_ID_PATTERN);
  if (m) return Number(m[1]);
  m = s.match(/编号[：:]\s*#?(\d+)/);
  if (m) return Number(m[1]);
  m = s.match(/#(\d{3,8})/);
  if (m) return Number(m[1]);
  return null;
}

function pickField(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const v = obj[k];
    if (v == null) continue;
    const s = typeof v === 'string' ? v.trim() : String(v);
    if (s) return s;
  }
  return '';
}

function unwrapData(body) {
  const root = body && typeof body === 'object' ? body : {};
  if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) return root.data;
  return root;
}

function collectRawXmlStrings(data, root) {
  const list = [];
  const add = (v) => {
    if (typeof v === 'string' && v.includes('<')) list.push(v);
  };
  add(data?.raw_msg);
  add(data?.rawMsg);
  add(data?.xml);
  add(data?.msgXml);
  add(data?.content);
  add(data?.msg_source);
  add(root?.raw_msg);
  add(root?.rawMsg);
  add(root?.xml);
  add(root?.data?.xml);
  if (root?.data && typeof root.data === 'object') {
    add(root.data.raw_msg);
    add(root.data.rawMsg);
    add(root.data.xml);
    add(root.data.msgXml);
  }
  return [...new Set(list)];
}

function extractAppmsgTitle(raw) {
  const s = String(raw || '');
  if (!s.includes('<')) return '';
  const appmsg = s.match(/<appmsg[\s\S]*?<\/appmsg>/i);
  const scope = appmsg?.[0] || s;
  const referIdx = scope.search(/<refermsg[\s>]/i);
  const head = referIdx > 0 ? scope.slice(0, referIdx) : scope;
  const title = head.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
  return title ? title.trim() : '';
}

function extractReferMsgFromXml(raw) {
  const s = String(raw || '');
  if (!/refermsg/i.test(s)) return { quotedMsgId: '', quoteText: '' };

  const block = s.match(/<refermsg>([\s\S]*?)<\/refermsg>/i);
  const inner = block?.[1] || s;

  const svrid = inner.match(/<svrid>([\s\S]*?)<\/svrid>/i)?.[1]?.trim();
  const msgid = inner.match(/<msgid>([\s\S]*?)<\/msgid>/i)?.[1]?.trim();
  const newmsgid = inner.match(/<newmsgid>([\s\S]*?)<\/newmsgid>/i)?.[1]?.trim();
  const content = inner.match(/<content>([\s\S]*?)<\/content>/i)?.[1]?.trim();

  return {
    quotedMsgId: svrid || msgid || newmsgid || '',
    quoteText: content || '',
  };
}

function extractQuoteFromXml(raw) {
  const refer = extractReferMsgFromXml(raw);
  if (refer.quotedMsgId || refer.quoteText) return refer;

  const s = String(raw || '');
  if (!s.includes('<')) return { quotedMsgId: '', quoteText: '' };
  const svrid = s.match(/<svrid>([\s\S]*?)<\/svrid>/i)?.[1]?.trim();
  const msgid = s.match(/<msgid>([\s\S]*?)<\/msgid>/i)?.[1]?.trim();
  const title = s.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const content = s.match(/<content>([\s\S]*?)<\/content>/i)?.[1]?.trim();
  return {
    quotedMsgId: svrid || msgid || '',
    quoteText: title || content || '',
  };
}

function extractWxMsgId(data, root) {
  return (
    pickField(data, ['msgid', 'msgId', 'messageId', 'message_id', 'wxMsgId', 'wx_msg_id']) ||
    pickField(root, ['msgid', 'msgId', 'messageId', 'message_id'])
  );
}

function extractRawText(data, root) {
  const direct =
    pickField(data, ['msg', 'content', 'text']) || pickField(root, ['msg', 'content', 'text']);
  if (direct) return direct;

  for (const xml of collectRawXmlStrings(data, root)) {
    const title = extractAppmsgTitle(xml);
    if (title) return title;
    const plain = extractQuoteFromXml(xml).quoteText;
    if (plain && !plain.includes('【千帆待回复')) {
      return plain;
    }
  }

  for (const xml of collectRawXmlStrings(data, root)) {
    const title = extractAppmsgTitle(xml);
    if (title) return title;
  }

  return '';
}

function extractQuoteInfo(data, root) {
  const candidates = [
    data?.referMsg,
    data?.refermsg,
    data?.quote,
    data?.quoted,
    data?.refer,
    root?.referMsg,
    root?.refermsg,
    root?.quote,
    root?.data?.refer,
    root?.data?.refermsg,
    root?.data?.quote,
    root?.data?.quoted,
  ].filter(Boolean);

  let quotedMsgId = pickField(data, [
    'quoteMsgId',
    'quotedMsgId',
    'quote_msg_id',
    'referMsgId',
    'sourceMsgId',
    'svrid',
  ]);
  let quoteText = '';

  for (const obj of candidates) {
    if (!obj || typeof obj !== 'object') continue;
    quotedMsgId =
      quotedMsgId ||
      pickField(obj, [
        'msgid',
        'msgId',
        'messageId',
        'svrid',
        'sourceMsgId',
        'referMsgId',
        'quoteMsgId',
        'quotedMsgId',
        'newmsgid',
      ]);
    quoteText =
      quoteText ||
      pickField(obj, ['content', 'msg', 'text', 'title', 'displayname', 'displayName']);
  }

  for (const xml of collectRawXmlStrings(data, root)) {
    const xmlQuote = extractReferMsgFromXml(xml);
    quotedMsgId = quotedMsgId || xmlQuote.quotedMsgId;
    quoteText = quoteText || xmlQuote.quoteText;
  }

  return { quotedMsgId, quoteText };
}

function parseNumberReply(rawText) {
  const text = String(rawText || '').trim();
  const m = text.match(NUMBER_REPLY_PATTERN);
  if (!m) return null;
  return {
    replyId: Number(m[1]),
    replyText: m[2].trim(),
    source: 'number_prefix',
  };
}

function isQuoteReplyMessage(data, root) {
  const msgType = Number(root?.msg_type || root?.msgType || data?.msg_type || 0);
  if (msgType === 11061) return true;
  return collectRawXmlStrings(data, root).some((xml) => /refermsg/i.test(xml));
}

function isLikelyNonTextMessage(data, root, rawText) {
  if (isQuoteReplyMessage(data, root)) {
    const text = String(rawText || '').trim() || extractRawText(data, root);
    return !text;
  }

  const wxType = Number(data?.wx_type || data?.wxType || root?.wx_type || 1);
  const msgType = Number(root?.msg_type || data?.msg_type || 0);
  if (msgType === 11047 || msgType === 11048) return true;
  if (wxType !== 1 && wxType !== 0 && !rawText) return true;

  const xmlList = collectRawXmlStrings(data, root);
  if (!String(rawText || '').trim() && xmlList.some((x) => /<img[\s>]/i.test(x) || /<voice[\s>]/i.test(x))) {
    return true;
  }
  return false;
}

function parseAuthorizedWechatReply(parsed, body) {
  const from = parsed?.from || '';
  if (!from || !isAuthorizedReplyWxid(from)) {
    return { ok: false, reason: 'unauthorized', authorized: false };
  }

  const root = body && typeof body === 'object' ? body : parsed.raw || {};
  const data = unwrapData(root);
  const rawText = extractRawText(data, root) || parsed.rawText || parsed.content || '';
  const wxMsgId = extractWxMsgId(data, root) || parsed.wxMsgId || '';
  const quote = extractQuoteInfo(data, root);

  if (isLikelyNonTextMessage(data, root, rawText)) {
    return {
      ok: false,
      authorized: true,
      reason: 'non_text',
      wxMsgId,
      rawText,
      quote,
      body,
      root,
      data,
    };
  }

  let replyId = null;
  let replyText = String(rawText || '').trim();
  let source = null;
  let quotedWxMsgId = '';
  let quoteText = '';
  let quoteParsedReplyId = null;
  let mappedReplyId = null;

  quoteText = String(quote.quoteText || '').trim();
  quotedWxMsgId = String(quote.quotedMsgId || '').trim();
  if (quoteText) {
    quoteParsedReplyId = parseReplyIdFromText(quoteText);
  }

  let mappedFromQuote = null;
  if (quotedWxMsgId) {
    mappedFromQuote = lookupSentNotificationForQuote(quotedWxMsgId, from);
    if (mappedFromQuote?.replyId) {
      mappedReplyId = Number(mappedFromQuote.replyId);
      replyId = mappedReplyId;
      source = 'quote';
    }
  }

  if (
    quotedWxMsgId &&
    quoteParsedReplyId != null &&
    mappedReplyId != null &&
    Number(quoteParsedReplyId) !== Number(mappedReplyId)
  ) {
    return {
      ok: false,
      authorized: true,
      reason: 'quote_reply_id_conflict',
      replyId: mappedReplyId,
      wxMsgId,
      rawText,
      quote,
      quotedWxMsgId,
      quoteText,
      quoteParsedReplyId,
      mappedReplyId,
      source,
      body,
      root,
      data,
    };
  }

  if (quotedWxMsgId && !replyId) {
    if (quoteText && REPLY_ID_PATTERN.test(quoteText) && quoteParsedReplyId) {
      replyId = Number(quoteParsedReplyId);
      source = 'quote_text_id';
    } else {
      return {
        ok: false,
        authorized: true,
        reason: 'quote_map_miss',
        replyId: null,
        wxMsgId,
        rawText,
        quote,
        quotedWxMsgId,
        quoteText,
        quoteParsedReplyId,
        mappedReplyId,
        body,
        root,
        data,
      };
    }
  }

  if (!replyId && quoteText && !quotedWxMsgId) {
    quoteParsedReplyId = parseReplyIdFromText(quoteText);
    if (quoteParsedReplyId) {
      replyId = Number(quoteParsedReplyId);
      source = 'quote';
    }
  }

  if (!replyId) {
    const numberParsed = parseNumberReply(rawText);
    if (numberParsed) {
      replyId = numberParsed.replyId;
      replyText = numberParsed.replyText;
      source = numberParsed.source;
    }
  }

  if (!replyId || !replyText) {
    let reason = 'no_reply_id';
    if (replyId && !replyText) reason = 'empty_reply_text';
    return {
      ok: false,
      authorized: true,
      reason,
      replyId: replyId || null,
      wxMsgId,
      rawText,
      quote,
      quotedWxMsgId,
      quoteText,
      quoteParsedReplyId,
      mappedReplyId,
      source,
      body,
      root,
      data,
    };
  }

  return {
    ok: true,
    authorized: true,
    replyId,
    replyText,
    source,
    mode: source,
    wxMsgId,
    quote,
    quotedWxMsgId,
    quoteText,
    quoteParsedReplyId,
    mappedReplyId,
    rawText,
  };
}

function parseRobotNotificationForMap(parsed, body) {
  const robotWxid = config.robotAccount?.wxid || config.loginBotWxid;
  if (parsed.from !== robotWxid) return null;

  const to = parsed.to || '';
  const target = findNotifyTargetByRecipient(to);
  if (!target) return null;

  const root = body && typeof body === 'object' ? body : parsed.raw || {};
  const data = unwrapData(root);
  const text = extractRawText(data, root) || parsed.rawText || parsed.content || '';
  const replyId = parseReplyIdFromText(text);
  if (!replyId) return null;

  const wxMsgId = extractWxMsgId(data, root) || parsed.wxMsgId || '';
  if (!wxMsgId) return null;

  const pending = findPendingByReplyId(replyId);

  return {
    wxMsgId,
    replyId,
    shopTitle: extractNoticeField(text, '店铺') || pending?.shopTitle || '',
    buyerNick: extractNoticeField(text, '买家') || pending?.buyerNick || '',
    appCid: pending?.appCid || '',
    targetWxid: target.wxid,
    sentAt: Date.now(),
  };
}

function formatInvalidReplyReason(reason = '') {
  const map = {
    no_reply_id: '没有识别到引用通知或 #编号',
    quote_map_miss: '引用的不是待回复通知，请重新引用【千帆待回复 #编号】',
    quote_reply_id_conflict: '引用消息和编号不一致，为避免发错人已拦截',
    empty_reply_text: '已识别编号，但回复内容为空，请在引用后输入文字',
    non_text: '当前只支持文本回复，请发送文字内容',
  };
  return map[reason] || String(reason || '无法识别回复');
}

function shouldNotifyInvalidReply(reply = {}) {
  if (!reply.authorized) return false;
  const reason = String(reply.reason || '');
  if (reason === 'quote_map_miss' || reason === 'empty_reply_text' || reason === 'quote_reply_id_conflict') {
    return true;
  }
  if (reason === 'no_reply_id' || reason === 'non_text') {
    return isReplyAttempt(reply.rawText, reply.quote);
  }
  return false;
}

function isReplyAttempt(rawText, quote) {
  const text = String(rawText || '').trim();
  if (quote?.quotedMsgId || quote?.quoteText) return true;
  if (/^#?\d{3,8}\s+/.test(text)) return true;
  if (isQuoteReplyMessage({}, { raw_msg: quote?.quoteText })) return true;
  return false;
}

function parseDebugLogPath() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const dir = path.join(config.root, 'logs', 'debug');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `wechat-reply-parse-debug-${y}-${m}-${day}.jsonl`);
}

function writeParseDebugLog(entry) {
  fs.appendFileSync(parseDebugLogPath(), `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

function summarizeRawKeys(body) {
  const keys = new Set();
  const walk = (obj, depth) => {
    if (!obj || typeof obj !== 'object' || depth > 3) return;
    for (const k of Object.keys(obj)) {
      keys.add(k);
      if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) walk(obj[k], depth + 1);
    }
  };
  walk(body, 0);
  return [...keys];
}

module.exports = {
  parseAuthorizedWechatReply,
  parseRobotNotificationForMap,
  parseReplyIdFromText,
  extractWxMsgId,
  extractRawText,
  extractQuoteInfo,
  isReplyAttempt,
  shouldNotifyInvalidReply,
  formatInvalidReplyReason,
  isQuoteReplyMessage,
  collectRawXmlStrings,
  writeParseDebugLog,
  summarizeRawKeys,
};
