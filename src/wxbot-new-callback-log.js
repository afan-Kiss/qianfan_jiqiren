/**
 * wxbot-new 回调解析与落盘
 */
const fs = require('fs');
const path = require('path');
const config = require('./wechat/wxbot-new-config');
const { getAuthorizedReplyWxids } = config;

const FROM_KEYS = [
  'from_wxid',
  'fromWxid',
  'fromUser',
  'from_user',
  'sender',
  'sender_wxid',
  'talker',
  'userName',
  'UserName',
  'username',
  'wxid',
];

const TO_KEYS = ['to_wxid', 'toWxid', 'to_user', 'receiver', 'receiver_wxid'];

const CONTENT_KEYS = ['content', 'msg', 'text', 'message', 'Message', 'title'];

const MSG_ID_KEYS = ['msgid', 'msgId', 'messageId', 'message_id', 'wxMsgId', 'wx_msg_id'];

function pickField(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const v = obj[k];
    if (v == null) continue;
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return '';
}

function extractTextFromXml(raw) {
  const s = String(raw || '');
  if (!s.includes('<')) return '';
  const title = s.match(/<title>([\s\S]*?)<\/title>/i);
  if (title && title[1]) return title[1].trim();
  const content = s.match(/<content>([\s\S]*?)<\/content>/i);
  if (content && content[1]) return content[1].trim();
  return '';
}

function unwrapData(body) {
  const root = body && typeof body === 'object' ? body : {};
  if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) return root.data;
  if (root.body?.data && typeof root.body.data === 'object') return root.body.data;
  if (root.payload?.data && typeof root.payload.data === 'object') return root.payload.data;
  return root;
}

function todayLogPath() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const dir = path.join(config.root, 'logs', 'debug');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `wxbot-callback-${y}-${m}-${day}.jsonl`);
}

function extractRawMessageText(data, root) {
  return (
    pickField(data, CONTENT_KEYS) ||
    pickField(root, CONTENT_KEYS) ||
    extractTextFromXml(data.raw_msg || data.rawMsg || root.raw_msg || root.rawMsg) ||
    ''
  );
}

function extractMessageText(data, root) {
  let text = extractRawMessageText(data, root);

  if (!text && data.quote && typeof data.quote === 'object') {
    text = pickField(data.quote, CONTENT_KEYS);
  }

  if (!text && typeof data.content === 'object' && data.content) {
    text = pickField(data.content, CONTENT_KEYS);
  }

  return String(text || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCallbackPayload(body) {
  const root = body && typeof body === 'object' ? body : {};
  const data = unwrapData(root);
  const from = pickField(data, FROM_KEYS) || pickField(root, FROM_KEYS);
  const to = pickField(data, TO_KEYS) || pickField(root, TO_KEYS);
  const room = pickField(data, ['room_wxid', 'roomWxid', 'chatroom', 'group_wxid']) ||
    pickField(root, ['room_wxid', 'roomWxid']);
  const rawText = extractRawMessageText(data, root);
  const content = extractMessageText(data, root);
  const wxMsgId = pickField(data, MSG_ID_KEYS) || pickField(root, MSG_ID_KEYS);
  const msgType = root.msg_type || root.msgType || data.msg_type || data.msgType || '';
  const hasRawXml = Boolean(
    (data.raw_msg || data.rawMsg || root.raw_msg || root.rawMsg || '').includes('<')
  );

  return {
    from,
    to,
    room,
    content,
    rawText,
    wxMsgId,
    msgType,
    hasRawXml,
    raw: root,
  };
}

function formatCallbackConsoleLine(parsed) {
  const now = new Date();
  const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const from = parsed.from || 'unknown';
  const to = parsed.to ? ` to=${parsed.to}` : '';
  const room = parsed.room ? ` room=${parsed.room}` : '';
  const msg =
    parsed.content ||
    parsed.rawText ||
    (parsed.msgType ? `(msg_type=${parsed.msgType})` : '(无文本内容)');
  const robotWxid = config.robotAccount?.wxid || config.loginBotWxid;
  const authorizedWxids = getAuthorizedReplyWxids();

  let tag = '非授权账号消息';
  if (robotWxid && from === robotWxid) tag = '机器人号';
  else if (authorizedWxids.includes(from)) tag = '接收号';

  return `[微信回调] ${t} [${tag}] from=${from}${to}${room} msg=${msg}`;
}

function previewMessageText(text, maxLen = 120) {
  const preview = String(text || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!preview) return '(无文本内容)';
  return preview.length > maxLen ? `${preview.slice(0, maxLen)}...` : preview;
}

function formatWechatSendConsoleLine({ wxid, content, label = '' }) {
  const now = new Date();
  const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const target = label ? `${label} ${wxid}` : wxid;
  return `[微信发送] ${t} to=${target} msg=${previewMessageText(content)}`;
}

function isAuthorizedCallbackSender(from) {
  const robotWxid = config.robotAccount?.wxid || config.loginBotWxid;
  const id = String(from || '').trim();
  if (!id) return false;
  return id === robotWxid || getAuthorizedReplyWxids().includes(id);
}

function shouldLogCallback(parsed) {
  return isAuthorizedCallbackSender(parsed?.from);
}

function appendCallbackLog(body) {
  const parsed = normalizeCallbackPayload(body);
  if (shouldLogCallback(parsed)) {
    const entry = {
      time: new Date().toISOString(),
      body,
    };
    fs.appendFileSync(todayLogPath(), `${JSON.stringify(entry)}\n`, 'utf8');
  }
  return parsed;
}

module.exports = {
  appendCallbackLog,
  normalizeCallbackPayload,
  formatCallbackConsoleLine,
  formatWechatSendConsoleLine,
  previewMessageText,
  shouldLogCallback,
  isAuthorizedCallbackSender,
  todayLogPath,
};
