/**
 * 千帆消息解析（HTTP / WebSocket）+ 统一归一化
 */
const fs = require('fs');
const path = require('path');

function parseMaybeJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  const s = String(text).trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function safeJsonParseDeep(value, maxDepth = 3, depth = 0) {
  if (depth >= maxDepth) return value;
  if (value == null) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return value;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = parseMaybeJson(trimmed);
      if (parsed != null && parsed !== value) return safeJsonParseDeep(parsed, maxDepth, depth + 1);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => safeJsonParseDeep(v, maxDepth, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = safeJsonParseDeep(v, maxDepth, depth + 1);
    return out;
  }
  return value;
}

function deepParseJson(value, depth = 0) {
  return safeJsonParseDeep(value, 4, depth);
}

const HTTP_URL_RE = /^https?:\/\//i;

function isHttpUrl(value) {
  return HTTP_URL_RE.test(String(value || '').trim());
}

function toReadableScalar(value) {
  if (value == null) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s || s === '[object Object]' || s === 'undefined' || s === 'null' || s === 'NaN') return '';
    if ((s.startsWith('{') || s.startsWith('[')) && parseMaybeJson(s)) return '';
    return s;
  }
  return '';
}

function isBadDisplayText(text) {
  const s = String(text || '').trim();
  return !s || s === '[object Object]' || s === 'undefined' || s === 'null' || s === 'NaN';
}

function pickFieldFromObjects(objects, fields) {
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue;
    for (const key of fields) {
      const v = obj[key];
      const s = toReadableScalar(v);
      if (s) return s;
    }
  }
  return '';
}

const IMAGE_URL_FIELDS = [
  'url',
  'imageUrl',
  'imgUrl',
  'originUrl',
  'originalUrl',
  'thumbUrl',
  'thumbnailUrl',
  'cdnUrl',
  'fileUrl',
  'mediaUrl',
  'picUrl',
  'pictureUrl',
  'cover',
  'coverUrl',
  'image',
];

function collectImageUrlsFromValue(value, out, depth = 0) {
  if (depth > 8 || out.length >= 20) return;
  if (value == null) return;

  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return;
    if (isHttpUrl(s)) {
      out.push(s);
      return;
    }
    if (s.startsWith('{') || s.startsWith('[')) {
      const parsed = parseMaybeJson(s);
      if (parsed != null && parsed !== value) collectImageUrlsFromValue(parsed, out, depth + 1);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const v of value) collectImageUrlsFromValue(v, out, depth + 1);
    return;
  }

  if (typeof value === 'object') {
    for (const key of IMAGE_URL_FIELDS) {
      const v = value[key];
      if (isHttpUrl(v)) out.push(String(v).trim());
    }
    for (const v of Object.values(value)) collectImageUrlsFromValue(v, out, depth + 1);
  }
}

function extractImageUrlsFromObjects(objects) {
  const found = [];
  for (const obj of objects) collectImageUrlsFromValue(safeJsonParseDeep(obj), found);
  const uniq = [...new Set(found.filter(isHttpUrl))];
  const thumb =
    uniq.find((u) => /thumb|thumbnail|small|preview|cover/i.test(u)) || uniq[uniq.length - 1] || '';
  const origin =
    uniq.find((u) => /origin|original|large|full/i.test(u)) || uniq[0] || thumb;
  const imageUrls = [...new Set([origin, ...uniq].filter(Boolean))];
  return { imageUrls, thumbUrl: thumb || imageUrls[0] || '' };
}

function parseSenderInfo(item) {
  const extRaw = item?.extension || {};
  const ext = safeJsonParseDeep(parseMaybeJson(extRaw.sender) || extRaw);
  const sender = safeJsonParseDeep(ext.sender) || ext.sender || ext.presentInfo || ext.representInfo || ext;
  const present = sender?.presentInfo || sender?.representInfo || sender || {};
  return {
    senderType: String(present.type || sender?.type || item?.senderType || '').toUpperCase(),
    buyerNick: String(present.nickName || present.nickname || item?.buyerNick || '').trim(),
    senderAppUid: String(item?.senderAppUid || present.appUid || '').trim(),
  };
}

function extractInnerPayload(item) {
  const contentInfo = safeJsonParseDeep(item?.contentInfo || item?.content_info || {});
  const rawContent = contentInfo.content ?? contentInfo.content_info;
  let root = {};
  let data = {};
  let innerText = '';
  let innerType = Number(contentInfo.contentType ?? contentInfo.content_type ?? 0);

  if (typeof rawContent === 'string') {
    const trimmed = rawContent.trim();
    const parsed =
      trimmed && (trimmed.startsWith('{') || trimmed.startsWith('[')) ? parseMaybeJson(trimmed) : null;
    if (parsed && typeof parsed === 'object') {
      root = safeJsonParseDeep(parsed);
      data = safeJsonParseDeep(root?.data || root);
      innerType = Number(
        data?.content_type ?? data?.contentType ?? data?.type ?? root?.type ?? innerType
      );
      innerText = toReadableScalar(data?.content ?? data?.text ?? root?.text ?? root?.title);
    } else if (trimmed) {
      innerText = toReadableScalar(trimmed);
      innerType = innerType || 1;
      data = { content: trimmed, content_type: innerType };
    }
  } else if (rawContent && typeof rawContent === 'object') {
    root = safeJsonParseDeep(rawContent);
    data = safeJsonParseDeep(root?.data || root);
    innerType = Number(
      data?.content_type ?? data?.contentType ?? data?.type ?? root?.type ?? innerType
    );
    innerText = toReadableScalar(data?.content ?? data?.text ?? root?.text ?? root?.title);
  }

  const summary = toReadableScalar(root?.summary || contentInfo.summary);
  if (!innerText && typeof data?.content === 'object') {
    innerText = pickFieldFromObjects([data.content, data, root], ['text', 'title', 'name', 'desc']);
  }
  return { contentInfo, root, data, summary, innerType, innerText };
}

function readTypeHints(item, inner) {
  const { contentInfo, root, data, innerType } = inner;
  const hints = [
    contentInfo?.contentType,
    contentInfo?.content_type,
    item?.contentType,
    item?.content_type,
    item?.msgType,
    item?.messageType,
    item?.type,
    data?.msgType,
    data?.type,
    root?.type,
    innerType,
  ]
    .map((v) => String(v ?? '').trim().toLowerCase())
    .filter(Boolean);
  return { hints, innerType };
}

function hintIncludes(hints, words) {
  return hints.some((h) => words.some((w) => h === w || h.includes(w)));
}

function isImageType(hints, innerType) {
  if (hintIncludes(hints, ['image', '图片', 'img', 'picture', 'pic'])) return true;
  return [2, 3, 4].includes(Number(innerType));
}

function isVideoType(hints, innerType, objects) {
  if (hintIncludes(hints, ['video', '视频', 'shortvideo', 'short_video'])) return true;
  if ([21, 22, 23, 24].includes(Number(innerType))) return true;
  return Boolean(
    pickFieldFromObjects(objects, ['videoUrl', 'video_url', 'playUrl', 'play_url', 'mediaUrl'])
  );
}

function isVoiceType(hints, innerType) {
  if (hintIncludes(hints, ['voice', 'audio', '语音', 'sound'])) return true;
  return [12, 13, 14, 15, 16].includes(Number(innerType));
}

function isFileType(hints, innerType, objects) {
  if (hintIncludes(hints, ['file', '文件', 'document', 'attachment'])) return true;
  return Boolean(pickFieldFromObjects(objects, ['fileName', 'file_name', 'filename', 'fileUrl', 'file_url']));
}

function isEmojiType(hints, innerType) {
  if (hintIncludes(hints, ['emoji', 'emoticon', 'sticker', '表情', 'meme'])) return true;
  return [18, 19].includes(Number(innerType));
}

function isProductType(hints, innerType, objects) {
  if (hintIncludes(hints, ['product', 'goods', 'item', 'commodity', '商品', 'card', 'sku', 'spu'])) return true;
  if ([5, 6, 7, 8, 9, 10, 11, 17, 20].includes(Number(innerType))) return true;
  const title = pickFieldFromObjects(objects, [
    'title',
    'name',
    'goodsTitle',
    'itemTitle',
    'productName',
    'spuName',
    'goods_name',
  ]);
  const price = pickFieldFromObjects(objects, [
    'price',
    'salePrice',
    'minPrice',
    'finalPrice',
    'payPrice',
    'goodsPrice',
  ]);
  return Boolean(title && (price || pickFieldFromObjects(objects, ['image', 'imageUrl', 'cover', 'spuId', 'goodsId'])));
}

function isOrderType(hints, innerType, objects) {
  if (hintIncludes(hints, ['order', '订单', 'package', 'trade'])) return true;
  return Boolean(
    pickFieldFromObjects(objects, [
      'orderId',
      'orderSn',
      'orderNo',
      'packageId',
      'order_id',
      'order_sn',
    ])
  );
}

function formatPrice(value) {
  const s = toReadableScalar(value);
  if (!s) return '';
  if (/[¥￥]/.test(s)) return s;
  if (/^\d+(\.\d+)?$/.test(s)) return `¥${s}`;
  return s;
}

function extractProductInfo(objects) {
  const title = pickFieldFromObjects(objects, [
    'title',
    'name',
    'goodsTitle',
    'itemTitle',
    'productName',
    'spuName',
    'goods_name',
    'productTitle',
  ]);
  const price = formatPrice(
    pickFieldFromObjects(objects, ['price', 'salePrice', 'minPrice', 'finalPrice', 'payPrice', 'goodsPrice'])
  );
  const productId = pickFieldFromObjects(objects, ['itemId', 'spuId', 'goodsId', 'productId', 'skuId']);
  const link = pickFieldFromObjects(objects, ['url', 'link', 'jumpUrl', 'detailUrl', 'goodsUrl']);
  const { imageUrls, thumbUrl } = extractImageUrlsFromObjects(objects);
  return {
    title,
    price,
    productId,
    link,
    imageUrl: imageUrls[0] || thumbUrl || '',
    imageUrls,
  };
}

function formatProductText(productInfo) {
  const lines = ['【商品卡片】'];
  if (productInfo?.title) lines.push(`标题：${productInfo.title}`);
  if (productInfo?.price) lines.push(`价格：${productInfo.price}`);
  if (lines.length === 1) return '【商品卡片】';
  return lines.join('\n');
}

function extractOrderInfo(objects) {
  const orderId = pickFieldFromObjects(objects, [
    'orderId',
    'orderSn',
    'orderNo',
    'packageId',
    'order_id',
    'order_sn',
  ]);
  const status = pickFieldFromObjects(objects, ['status', 'orderStatus', 'order_status', 'state', 'statusDesc']);
  const amount = formatPrice(
    pickFieldFromObjects(objects, ['amount', 'payAmount', 'totalAmount', 'orderAmount', 'price'])
  );
  const productTitle = pickFieldFromObjects(objects, ['productTitle', 'goodsTitle', 'title', 'itemTitle']);
  return { orderId, status, amount, productTitle };
}

function formatOrderText(orderInfo) {
  const lines = ['【订单消息】'];
  if (orderInfo?.orderId) lines.push(`订单号：${orderInfo.orderId}`);
  if (orderInfo?.status) lines.push(`状态：${orderInfo.status}`);
  if (orderInfo?.amount) lines.push(`金额：${orderInfo.amount}`);
  if (orderInfo?.productTitle && lines.length < 4) lines.push(`商品：${orderInfo.productTitle}`);
  if (lines.length === 1) return '【订单消息】';
  return lines.join('\n');
}

function extractVideoInfo(objects) {
  const videoUrl = pickFieldFromObjects(objects, ['videoUrl', 'video_url', 'playUrl', 'play_url', 'mediaUrl', 'url']);
  const { imageUrls, thumbUrl } = extractImageUrlsFromObjects(objects);
  return {
    videoUrl: isHttpUrl(videoUrl) ? videoUrl : '',
    coverUrl: thumbUrl || imageUrls[0] || '',
    imageUrls,
  };
}

function formatVideoText(videoInfo) {
  const lines = ['【视频消息】'];
  if (videoInfo?.videoUrl) lines.push(`链接：${videoInfo.videoUrl}`);
  return lines.join('\n');
}

function extractVoiceInfo(objects) {
  const durationRaw = pickFieldFromObjects(objects, [
    'duration',
    'voiceDuration',
    'audioDuration',
    'length',
    'time',
  ]);
  const sec = Number(durationRaw);
  return { durationSec: Number.isFinite(sec) && sec > 0 ? Math.round(sec) : 0 };
}

function formatVoiceText(voiceInfo) {
  if (voiceInfo?.durationSec > 0) return `【语音消息】${voiceInfo.durationSec}秒`;
  return '【语音消息】';
}

function extractFileInfo(objects) {
  const fileName = pickFieldFromObjects(objects, ['fileName', 'file_name', 'filename', 'name', 'title']);
  const fileUrl = pickFieldFromObjects(objects, ['fileUrl', 'file_url', 'url', 'downloadUrl']);
  return {
    fileName,
    fileUrl: isHttpUrl(fileUrl) ? fileUrl : '',
  };
}

function formatFileText(fileInfo) {
  const lines = ['【文件消息】'];
  if (fileInfo?.fileName) lines.push(`文件名：${fileInfo.fileName}`);
  return lines.join('\n');
}

function unknownMessageLogPath() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const { resolveLogsDir } = require('./shared/app-root');
  const dir = path.join(resolveLogsDir(), 'debug');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `qianfan-unknown-message-${y}-${m}-${day}.jsonl`);
}

function logUnknownMessageType(message) {
  try {
    const raw = message?.raw || {};
    const entry = {
      time: new Date().toISOString(),
      event: 'unknown_message_type',
      shopTitle: message?.shopTitle || '',
      appCid: message?.appCid || '',
      msgId: message?.msgId || '',
      rawKeys: raw && typeof raw === 'object' ? Object.keys(raw).slice(0, 80) : [],
      raw,
    };
    fs.appendFileSync(unknownMessageLogPath(), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // ignore
  }
}

/**
 * 统一千帆买家消息归一化
 */
function normalizeQianfanMessage(rawMessage) {
  const envelope = rawMessage && typeof rawMessage === 'object' ? rawMessage : {};
  const item = safeJsonParseDeep(
    envelope.raw && typeof envelope.raw === 'object'
      ? { ...envelope.raw, appCid: envelope.appCid || envelope.raw.appCid }
      : envelope
  );

  const shopTitle = String(envelope.shopTitle || item.shopTitle || '').trim();
  const appCid = String(envelope.appCid || item.appCid || '').trim();
  const msgId = extractStableMsgId(item, item, appCid);
  const createAt =
    normalizeCreateAtMs(item.createAt || item.createdAt || item.timestamp || envelope.createAt) ||
    Date.now();
  const sender = parseSenderInfo(item);
  const inner = extractInnerPayload(item);
  const { hints, innerType } = readTypeHints(item, inner);

  const objects = [
    item,
    inner.contentInfo,
    inner.root,
    inner.data,
    inner.data?.content,
    item.body,
    item.body?.data,
    item.data,
    envelope,
  ].filter((o) => o && typeof o === 'object');

  let contentType = 'unknown';
  let text = '【未知消息】';
  let summary = inner.summary || '';
  let imageUrls = [];
  let thumbUrl = '';
  let productInfo = null;
  let orderInfo = null;
  let videoInfo = null;
  let fileInfo = null;

  const tryText = inner.innerText || summary;

  if (isImageType(hints, innerType)) {
    contentType = 'image';
    const imgs = extractImageUrlsFromObjects(objects);
    imageUrls = imgs.imageUrls;
    thumbUrl = imgs.thumbUrl;
    text = '【图片消息】';
  } else if (isOrderType(hints, innerType, objects)) {
    contentType = 'order';
    orderInfo = extractOrderInfo(objects);
    text = formatOrderText(orderInfo);
  } else if (isProductType(hints, innerType, objects)) {
    contentType = 'product';
    productInfo = extractProductInfo(objects);
    text = formatProductText(productInfo);
    if (productInfo.imageUrl) {
      imageUrls = productInfo.imageUrls?.length ? productInfo.imageUrls : [productInfo.imageUrl];
      thumbUrl = productInfo.imageUrl;
    }
  } else if (isVideoType(hints, innerType, objects)) {
    contentType = 'video';
    videoInfo = extractVideoInfo(objects);
    text = formatVideoText(videoInfo);
    if (videoInfo.coverUrl) {
      imageUrls = videoInfo.imageUrls?.length ? videoInfo.imageUrls : [videoInfo.coverUrl];
      thumbUrl = videoInfo.coverUrl;
    }
  } else if (isVoiceType(hints, innerType)) {
    contentType = 'voice';
    const voiceInfo = extractVoiceInfo(objects);
    text = formatVoiceText(voiceInfo);
  } else if (isFileType(hints, innerType, objects)) {
    contentType = 'file';
    fileInfo = extractFileInfo(objects);
    text = formatFileText(fileInfo);
  } else if (isEmojiType(hints, innerType)) {
    contentType = 'emoji';
    text = '【表情消息】';
  } else if (Number(innerType) === 1 || hintIncludes(hints, ['text', '文本']) || (tryText && !isBadDisplayText(tryText))) {
    contentType = 'text';
    text = tryText || '【未知消息】';
    if (isBadDisplayText(text)) {
      contentType = 'unknown';
      text = '【未知消息】';
    }
  } else if (tryText && !isBadDisplayText(tryText)) {
    contentType = 'text';
    text = tryText;
  }

  if (isBadDisplayText(text)) {
    contentType = 'unknown';
    text = '【未知消息】';
  }

  return {
    shopTitle,
    appCid,
    msgId,
    buyerNick: sender.buyerNick || '买家',
    contentType,
    text,
    summary: toReadableScalar(summary) || text.split('\n')[0],
    imageUrls,
    thumbUrl,
    productInfo,
    orderInfo,
    videoInfo,
    fileInfo,
    createAt,
    senderType: sender.senderType,
    senderAppUid: sender.senderAppUid,
    source: String(envelope.source || item.source || 'unknown').trim(),
    raw: item,
    isImage: contentType === 'image',
    isUnknown: contentType === 'unknown',
  };
}

function isLikelyConversationId(id, appCid) {
  const s = String(id || '').trim();
  const cid = String(appCid || '').trim();
  if (!s) return true;
  if (cid && s === cid) return true;
  if (/^[\d.]+$/.test(s) && s.length < 8) return true;
  return false;
}

function extractStableMsgId(item, raw, appCid = '') {
  const cid = String(appCid || item?.appCid || raw?.appCid || '').trim();
  const objects = [
    item,
    raw,
    item?.contentInfo,
    item?.body,
    item?.body?.data,
    item?.data,
    item?.userMessage,
    raw?.contentInfo,
    raw?.body,
    raw?.body?.data,
    raw?.data,
  ];
  const preferred = pickFieldFromObjects(objects, [
    'msgId',
    'messageId',
    'msg_id',
    'message_id',
    'clientMsgId',
    'localMsgId',
    'serverMsgId',
    'sMid',
    'seqId',
    'uuid',
  ]);
  if (preferred && !isLikelyConversationId(preferred, cid)) return preferred;
  return '';
}

function normalizeCreateAtMs(value) {
  const n = Number(value || 0);
  if (!n) return 0;
  return n < 1e12 ? n * 1000 : n;
}

function buildBuyerMessage({ shopTitle, item, raw, source = 'unknown' }) {
  const normalized = normalizeQianfanMessage({
    shopTitle,
    source,
    appCid: item?.appCid,
    raw: safeJsonParseDeep(raw || item),
  });

  return {
    ...normalized,
    messageId: normalized.msgId,
    isSellerSide: false,
  };
}

function isBuyerMessageItem(item) {
  if (!item || typeof item !== 'object') return false;
  const sender = parseSenderInfo(item);
  if (sender.senderType === 'CUSTOMER') return true;
  if (String(item?.senderAppUid || '').includes('#2#2#')) return true;
  const extText = JSON.stringify(item?.extension || '');
  if (/\"type\":\"CUSTOMER\"/.test(extText)) return true;
  return false;
}

function isIgnoredMessage(message, reasonRef) {
  if (!message) return true;
  if (!message.appCid) {
    reasonRef.reason = '缺少 appCid';
    return true;
  }
  if (message.senderType && message.senderType !== 'CUSTOMER') {
    reasonRef.reason = `${message.senderType} 非买家`;
    return true;
  }

  if (isBadDisplayText(message.text)) {
    message.text = '【未知消息】';
    message.contentType = 'unknown';
    message.isUnknown = true;
  }

  const isImage = message.isImage || message.contentType === 'image';
  if (!String(message.text || '').trim() && !isImage) {
    reasonRef.reason = '空消息';
    return true;
  }
  if (isImage && !String(message.text || '').trim()) {
    message.text = '【图片消息】';
  }

  if (!message.msgId && !message.createAt) {
    reasonRef.reason = '缺少 msgId';
    return true;
  }

  const ext = JSON.stringify(message.raw?.extension || message.raw || '');
  if (/\"type\":\"SYSTEM\"/.test(ext) || message.senderType === 'SYSTEM') {
    reasonRef.reason = '系统消息';
    return true;
  }
  if (/\"type\":\"CSA\"/.test(ext) || /\"type\":\"BOT\"/.test(ext) || /\"type\":\"SELLER\"/.test(ext)) {
    reasonRef.reason = '客服自己消息';
    return true;
  }
  if (/typing|read|已读|正在输入/i.test(message.text)) {
    reasonRef.reason = '状态消息';
    return true;
  }
  return false;
}

function filterBuyerOnlyMessages(messages) {
  const out = [];
  for (const message of messages || []) {
    if (!message || message.isSellerSide) continue;
    const senderType = String(message.senderType || '').toUpperCase();
    if (senderType && senderType !== 'CUSTOMER') continue;
    const reasonRef = { reason: '' };
    if (isIgnoredMessage(message, reasonRef)) continue;
    out.push(message);
  }
  return out;
}

function extractMessagesFromResponse(body, shopTitle, source = 'http_message_list') {
  const parsed = deepParseJson(body);
  const out = [];
  const infos = parsed?.data?.infos;
  if (infos && typeof infos === 'object') {
    for (const [appCid, block] of Object.entries(infos)) {
      const list = block?.userMessageInfos || block?.messages || [];
      for (const item of list) {
        out.push(
          buildBuyerMessage({
            shopTitle,
            item: { ...item, appCid: item.appCid || appCid },
            raw: item,
            source: source === 'http_message_list' ? 'http_batch' : source,
          })
        );
      }
    }
  }
  const directList =
    parsed?.data?.userMessageInfos ||
    parsed?.data?.messages ||
    parsed?.data?.list ||
    parsed?.data?.messageList ||
    [];
  if (Array.isArray(directList)) {
    for (const item of directList) {
      out.push(buildBuyerMessage({ shopTitle, item, raw: item, source }));
    }
  }
  return out;
}

function isSellerSideSender(senderType) {
  const s = String(senderType || '').toUpperCase();
  if (!s) return false;
  if (s === 'CUSTOMER') return false;
  return (
    s === 'SELLER' ||
    s === 'CSA' ||
    s === 'STAFF' ||
    s === 'ROBOT' ||
    s === 'BOT' ||
    s.includes('SERVICE')
  );
}

function parseWsSessionMessages(payload, shopTitle) {
  const root = deepParseJson(payload);
  const body = root?.body || {};
  const items = Array.isArray(body.payload) ? body.payload : [body];
  const out = [];

  for (const block of items) {
    const data = deepParseJson(parseMaybeJson(block?.data) || block?.data || block);
    const userMessage = data?.userMessage || data?.message;
    if (!userMessage || typeof userMessage !== 'object') continue;

    const sender = parseSenderInfo(userMessage);
    const msg = buildBuyerMessage({ shopTitle, item: userMessage, raw: userMessage, source: 'ws' });
    msg.senderType = sender.senderType || msg.senderType;
    msg.isSellerSide = isSellerSideSender(msg.senderType);
    out.push(msg);
  }

  return out;
}

function parseWsBuyerMessage(payload, shopTitle) {
  const root = deepParseJson(payload);
  const body = root?.body || {};
  const items = Array.isArray(body.payload) ? body.payload : [body];
  const out = [];

  for (const block of items) {
    const data = deepParseJson(parseMaybeJson(block?.data) || block?.data || block);
    const userMessage = data?.userMessage || data?.message || data;
    if (!userMessage || typeof userMessage !== 'object') continue;

    const sender = parseSenderInfo(userMessage);
    if (sender.senderType !== 'CUSTOMER' && !String(userMessage.senderAppUid || '').includes('#2#2#')) {
      continue;
    }

    const msg = buildBuyerMessage({ shopTitle, item: userMessage, raw: userMessage, source: 'ws' });
    msg.senderType = sender.senderType || msg.senderType;
    const blockTime = normalizeCreateAtMs(data?.time || userMessage.createAt || userMessage.createdAt);
    if (blockTime) msg.createAt = blockTime;
    out.push(msg);
  }

  return out;
}

function isWsBuyerCandidate(message) {
  if (!message || message.isSellerSide) return false;
  const senderType = String(message.senderType || '').toUpperCase();
  if (senderType === 'CUSTOMER') return true;
  const uid = String(message.senderAppUid || message.raw?.senderAppUid || '');
  if (uid.includes('#2#2#')) return true;
  return isBuyerMessageItem(message.raw);
}

/** WebSocket 帧 → 买家消息（主解析 + 会话同步兜底） */
function extractBuyerMessagesFromWsPayload(payload, shopTitle) {
  const direct = parseWsBuyerMessage(payload, shopTitle);
  if (direct.length) return direct;

  const action = String(payload?.header?.action || '');
  if (action && action !== '/sync/unreliable' && !action.includes('/message/')) {
    return [];
  }

  const sessionMsgs = parseWsSessionMessages(payload, shopTitle);
  return sessionMsgs.filter(isWsBuyerCandidate);
}

function collectMessageImageUrls(message) {
  const urls = [...(message?.imageUrls || [])];
  if (message?.thumbUrl) urls.push(message.thumbUrl);
  if (message?.productInfo?.imageUrl) urls.push(message.productInfo.imageUrl);
  if (message?.videoInfo?.coverUrl) urls.push(message.videoInfo.coverUrl);
  return [...new Set(urls.filter(isHttpUrl))];
}

module.exports = {
  parseMaybeJson,
  deepParseJson,
  safeJsonParseDeep,
  normalizeQianfanMessage,
  buildBuyerMessage,
  extractStableMsgId,
  extractImageUrlsFromObjects,
  isHttpUrl,
  collectMessageImageUrls,
  logUnknownMessageType,
  normalizeCreateAtMs,
  isBuyerMessageItem,
  isIgnoredMessage,
  isBadDisplayText,
  extractMessagesFromResponse,
  filterBuyerOnlyMessages,
  parseWsBuyerMessage,
  parseWsSessionMessages,
  extractBuyerMessagesFromWsPayload,
  isWsBuyerCandidate,
  isSellerSideSender,
};
