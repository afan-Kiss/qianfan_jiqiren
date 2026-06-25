/**
 * wxbot-new 发送微信文本 / 图片
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./wechat/wxbot-new-config');
const { fetchWithTimeout } = require('./fetch-timeout');
const {
  assertWechatSendAllowed,
  clearSendFailureCounters,
  enrichWechatSendError,
  evaluateWxbotHealth,
} = require('./wechat/wechat-runtime-recovery');

const IMAGE_CACHE_DIR = path.join(config.root, 'data', 'wechat-image-cache');

function authHeaders(extra = {}) {
  const headers = { Accept: 'application/json', ...extra };
  if (config.username && config.password) {
    headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  }
  return headers;
}

function ensureImageCacheDir() {
  if (!fs.existsSync(IMAGE_CACHE_DIR)) fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
}

function guessImageExt(url, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('png')) return '.png';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('webp')) return '.webp';
  const m = String(url || '').match(/\.(jpe?g|png|gif|webp)(\?|$)/i);
  if (m) return `.${m[1].toLowerCase().replace('jpeg', 'jpg')}`;
  return '.jpg';
}

async function downloadImageToCache(imageUrl, msgId) {
  const url = String(imageUrl || '').trim();
  if (!isHttpUrl(url)) throw new Error('无效图片 URL');

  ensureImageCacheDir();
  const res = await fetchWithTimeout(
    url,
    {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      redirect: 'follow',
    },
    12000
  );
  if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('图片内容为空');

  const ext = guessImageExt(url, res.headers.get('content-type'));
  const base = String(msgId || Date.now())
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 80);
  const fileName = `${base}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  const localPath = path.join(IMAGE_CACHE_DIR, fileName);
  fs.writeFileSync(localPath, buf);
  return localPath;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function guardWechatSendAllowed() {
  try {
    assertWechatSendAllowed();
  } catch (err) {
    throw enrichWechatSendError(err, {});
  }
}

async function buildSendFaultMetaFromHealth() {
  try {
    const evaluation = await evaluateWxbotHealth();
    return {
      injectOk: evaluation.report?.injectOk,
      clientId: Number(evaluation.report?.clientId || 0),
    };
  } catch {
    return {};
  }
}

async function finalizeWechatSendFailure(err, meta = {}) {
  let healthMeta = meta;
  if (!meta.injectOk && !meta.clientId && !meta.httpStatus) {
    healthMeta = { ...meta, ...(await buildSendFaultMetaFromHealth()) };
  }
  throw enrichWechatSendError(err, healthMeta);
}

async function sendWxText(wxid, content) {
  guardWechatSendAllowed();

  const url = `${config.baseUrl.replace(/\/$/, '')}/api/wechat/send-text`;
  let res;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ wxid, content }),
      },
      8000
    );
  } catch (err) {
    await finalizeWechatSendFailure(err, { httpStatus: err?.httpStatus });
  }

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!res.ok || body?.code !== 0) {
    const err = new Error(body?.message || text || `HTTP ${res.status}`);
    err.httpStatus = res.status;
    await finalizeWechatSendFailure(err, { httpStatus: res.status, body });
  }

  clearSendFailureCounters();
  const data = body?.data || body || {};
  const wxMsgId = String(
    data.msgId || data.msgid || data.messageId || data.message_id || data.wxMsgId || ''
  ).trim();
  return { body, wxMsgId };
}

async function sendWxImageFile(wxid, localPath) {
  guardWechatSendAllowed();
  const absPath = path.resolve(localPath);
  if (!fs.existsSync(absPath)) throw new Error(`图片文件不存在：${absPath}`);

  const url = `${config.baseUrl.replace(/\/$/, '')}/api/wechat/send-image`;
  const buf = fs.readFileSync(absPath);
  const fileName = path.basename(absPath);
  const blob = new Blob([buf]);
  const form = new FormData();
  form.append('wxid', wxid);
  form.append('file', blob, fileName);

  let res;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: authHeaders(),
        body: form,
      },
      12000
    );
  } catch (err) {
    await finalizeWechatSendFailure(err, { httpStatus: err?.httpStatus });
  }

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!res.ok || body?.code !== 0) {
    const err = new Error(body?.message || text || `HTTP ${res.status}`);
    err.httpStatus = res.status;
    await finalizeWechatSendFailure(err, { httpStatus: res.status, body });
  }

  clearSendFailureCounters();
  const data = body?.data || body || {};
  const wxMsgId = String(
    data.msgId || data.msgid || data.messageId || data.message_id || data.wxMsgId || ''
  ).trim();
  return { body, wxMsgId, localPath: absPath };
}

/**
 * 转发买家图片到微信：优先下载后发本地文件；失败则发链接/提示文本
 */
async function sendWxBuyerImages(wxid, { imageUrls = [], msgId, replyId } = {}) {
  const urls = [...new Set((imageUrls || []).filter(isHttpUrl))];
  if (!urls.length) return { sent: 0, failed: 0, usedLink: false };

  let sent = 0;
  let failed = 0;
  let lastError = null;

  for (const imageUrl of urls.slice(0, 3)) {
    try {
      const localPath = await downloadImageToCache(imageUrl, msgId || replyId);
      await sendWxImageFile(wxid, localPath);
      sent += 1;
      return { sent, failed, usedLink: false, imageUrl, localPath };
    } catch (err) {
      lastError = err;
      failed += 1;
    }
  }

  const link = urls[0];
  try {
    await sendWxText(wxid, `图片链接：${link}`);
    return { sent: 0, failed, usedLink: true, imageUrl: link, error: lastError };
  } catch (err) {
    return { sent: 0, failed: failed + 1, usedLink: false, error: err || lastError };
  }
}

module.exports = {
  sendWxText,
  sendWxImageFile,
  sendWxBuyerImages,
  downloadImageToCache,
  IMAGE_CACHE_DIR,
};
