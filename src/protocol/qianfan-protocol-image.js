/**
 * 千帆纯协议测试 — 图片上传/发送分析（不硬猜字段）
 */
const fs = require('fs');
const path = require('path');
const { makeTraceId, makeSMid, makeUuid } = require('../qf-send-payload');
const { summarizePayload } = require('./qianfan-protocol-client');

const IMAGE_FIELD_CANDIDATES = [
  'url',
  'imageUrl',
  'fileId',
  'mediaId',
  'objectKey',
  'token',
  'width',
  'height',
  'size',
  'bucket',
  'path',
  'resourceId',
];

function isNonEmptyObject(obj) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length > 0;
}

function resolveImagePath(shopConfig, imagePathOverride) {
  const fromTarget = String(shopConfig?.testTarget?.imagePath || '').trim();
  const p = String(imagePathOverride || fromTarget || '').trim();
  if (!p) return { path: '', exists: false };
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  return { path: abs, exists: fs.existsSync(abs) };
}

function analyzeImageSendRequirements(shopConfig, imagePathOverride) {
  const uploadTpl = shopConfig?.httpTemplates?.imageUpload || {};
  const imageSendPayload = shopConfig?.manualSamples?.imageSendPayload;
  const imageUploadResponse = shopConfig?.manualSamples?.imageUploadResponse;
  const img = resolveImagePath(shopConfig, imagePathOverride);

  const missingFields = [];
  if (!String(uploadTpl.url || '').trim()) missingFields.push('httpTemplates.imageUpload.url');
  if (!isNonEmptyObject(imageSendPayload)) missingFields.push('manualSamples.imageSendPayload');
  if (!img.path) missingFields.push('testTarget.imagePath');
  else if (!img.exists) missingFields.push(`本地图片不存在: ${img.path}`);

  const appCid = String(shopConfig?.testTarget?.appCid || '').trim();
  const receiverAppUids = Array.isArray(shopConfig?.testTarget?.receiverAppUids)
    ? shopConfig.testTarget.receiverAppUids.filter(Boolean)
    : [];
  if (!appCid) missingFields.push('testTarget.appCid');
  if (!receiverAppUids.length) missingFields.push('testTarget.receiverAppUids');

  const advice = [];
  if (!isNonEmptyObject(imageSendPayload)) {
    advice.push(
      '缺少手动图片发送 WS payload 样本，请在千帆手动发一张图片，抓取 /message/send 的 WS frame，填入 manualSamples.imageSendPayload。'
    );
  }
  if (!String(uploadTpl.url || '').trim()) {
    advice.push('缺少图片上传接口模板，请手动抓包图片上传接口，填入 httpTemplates.imageUpload。');
  }
  if (isNonEmptyObject(imageSendPayload)) {
    const ct = imageSendPayload?.body?.contentInfo?.contentType;
    if (ct == null) advice.push('imageSendPayload 未暴露 contentType，请确认样本完整。');
  }

  return {
    canDryRunImagePayload: isNonEmptyObject(imageSendPayload),
    canUploadImage: Boolean(String(uploadTpl.url || '').trim() && img.exists),
    canReallySendImage:
      isNonEmptyObject(imageSendPayload) &&
      Boolean(String(uploadTpl.url || '').trim()) &&
      img.exists &&
      Boolean(appCid) &&
      receiverAppUids.length > 0,
    missingFields,
    advice,
    hasImageUploadResponseSample: isNonEmptyObject(imageUploadResponse),
    imagePath: img.path,
    imageExists: img.exists,
  };
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function collectImageLikeFields(obj, prefix = '', out = {}) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => collectImageLikeFields(item, `${prefix}[${i}]`, out));
    return out;
  }
  for (const [key, value] of Object.entries(obj)) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (IMAGE_FIELD_CANDIDATES.includes(key) && (typeof value === 'string' || typeof value === 'number')) {
      out[pathKey] = value;
    }
    if (value && typeof value === 'object') collectImageLikeFields(value, pathKey, out);
  }
  return out;
}

function buildImagePayloadFromManualSample({ shopConfig, appCid, receiverAppUids, uploadResult, seq = 1 }) {
  const sample = shopConfig?.manualSamples?.imageSendPayload;
  if (!isNonEmptyObject(sample)) {
    return {
      ok: false,
      missingFields: ['manualSamples.imageSendPayload'],
      error: '缺少手动图片 WS payload 样本',
    };
  }

  const payload = deepClone(sample.header && sample.body ? sample : { header: sample.header, body: sample.body });
  if (!payload.header) payload.header = {};
  if (!payload.body) payload.body = {};

  const traceId = makeTraceId();
  const sMid = makeSMid();
  const uuid = makeUuid();

  payload.header.sTime = Date.now();
  payload.header.seq = Number(seq) > 0 ? Number(seq) : 1;
  payload.header.traceId = traceId;
  payload.header.sMid = sMid;
  payload.header.action = payload.header.action || '/message/send';
  payload.header.serviceId = payload.header.serviceId || 'impaas.oi';
  payload.header.type = payload.header.type ?? 3;

  payload.body.appCid = appCid;
  payload.body.uuid = uuid;
  payload.body.receiverAppUids = [...receiverAppUids];

  const uploadFields =
    collectImageLikeFields(uploadResult) ||
    collectImageLikeFields(shopConfig?.manualSamples?.imageUploadResponse);

  const missingFields = [];
  const contentInfo = payload.body.contentInfo;
  if (!contentInfo || typeof contentInfo !== 'object') {
    return {
      ok: false,
      missingFields: ['body.contentInfo'],
      error: 'imageSendPayload 缺少 body.contentInfo，无法推断图片字段',
    };
  }

  if (contentInfo.contentType == null) {
    missingFields.push('contentInfo.contentType');
  }

  const mappedFields = {};
  for (const [pathKey, value] of Object.entries(uploadFields)) {
    mappedFields[pathKey] = value;
  }

  return {
    ok: missingFields.length === 0,
    payload,
    payloadSummary: summarizePayload(payload),
    traceId,
    sMid,
    uuid,
    mappedFields,
    missingFields,
    contentType: contentInfo.contentType,
    note:
      missingFields.length === 0
        ? '已基于手动样本生成图片 payload；请 dry-run 检查字段后再 --really-send'
        : '图片字段不完整，仅输出 payload summary，禁止强发',
  };
}

async function uploadImageByTemplate(shopConfig, imagePath, { reallyUpload = false } = {}) {
  const tpl = shopConfig?.httpTemplates?.imageUpload || {};
  const url = String(tpl.url || '').trim();
  const fieldName = String(tpl.fieldName || 'file').trim();
  const method = String(tpl.method || 'POST').toUpperCase();

  const img = resolveImagePath(shopConfig, imagePath);
  if (!url) {
    return { ok: false, error: '缺少 httpTemplates.imageUpload.url', dryRun: !reallyUpload };
  }
  if (!img.exists) {
    return { ok: false, error: `图片文件不存在: ${img.path}`, dryRun: !reallyUpload };
  }

  const stat = fs.statSync(img.path);
  const plan = {
    url,
    method,
    fieldName,
    fileSize: stat.size,
    fileName: path.basename(img.path),
    headers: {
      Cookie: '[redacted]',
      'User-Agent': shopConfig.userAgent ? '[set]' : '[missing]',
      Origin: shopConfig.origin,
      Referer: shopConfig.referer,
    },
    extraFields: tpl.extraFields || {},
  };

  if (!reallyUpload) {
    return { ok: true, dryRun: true, plan };
  }

  const form = new FormData();
  const blob = new Blob([fs.readFileSync(img.path)]);
  form.append(fieldName, blob, path.basename(img.path));
  const extra = tpl.extraFields && typeof tpl.extraFields === 'object' ? tpl.extraFields : {};
  for (const [k, v] of Object.entries(extra)) {
    form.append(k, String(v));
  }

  const headers = {
    Cookie: shopConfig.cookie,
    'User-Agent': shopConfig.userAgent,
    Origin: shopConfig.origin,
    Referer: shopConfig.referer,
    ...(tpl.headers || {}),
  };
  delete headers['Content-Type'];

  let res;
  let text = '';
  try {
    res = await fetch(url, { method, headers, body: form });
    text = await res.text();
  } catch (err) {
    return { ok: false, error: err.message || String(err), plan };
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: res.ok,
      status: res.status,
      rawTextPreview: text.slice(0, 1000),
      responseShape: 'non-json',
      plan,
    };
  }

  return {
    ok: res.ok,
    status: res.status,
    response: json,
    responseFields: collectImageLikeFields(json),
    plan,
  };
}

async function sendImage({
  client,
  shopConfig,
  appCid,
  receiverAppUids,
  imagePath,
  reallySend = false,
  reallyUpload = false,
}) {
  const analyze = analyzeImageSendRequirements(shopConfig, imagePath);
  if (!analyze.canDryRunImagePayload) {
    return {
      ok: false,
      skipped: true,
      analyze,
      error: analyze.advice.join(' '),
    };
  }

  let uploadResult = null;
  if (reallyUpload) {
    uploadResult = await uploadImageByTemplate(shopConfig, imagePath, { reallyUpload: true });
    if (!uploadResult.ok) {
      return { ok: false, analyze, uploadResult, error: uploadResult.error || '图片上传失败' };
    }
  } else if (analyze.canUploadImage) {
    uploadResult = await uploadImageByTemplate(shopConfig, imagePath, { reallyUpload: false });
  }

  const built = buildImagePayloadFromManualSample({
    shopConfig,
    appCid,
    receiverAppUids,
    uploadResult: uploadResult?.response || shopConfig?.manualSamples?.imageUploadResponse,
    seq: (client?.lastSeq || 0) + 1,
  });

  if (!built.ok) {
    return {
      ok: false,
      analyze,
      uploadResult,
      built,
      error: built.error || '图片 payload 字段不完整',
    };
  }

  if (!reallySend) {
    return {
      ok: true,
      dryRun: true,
      analyze,
      uploadResult,
      built,
      payloadSummary: built.payloadSummary,
    };
  }

  try {
    await client.openWsForSend();
    const sendResult = await client.sendRawWsPayload(built.payload, { reallySend: true });
    client.closeWs();
    return {
      ok: sendResult.ok,
      analyze,
      uploadResult,
      built,
      sendResult,
    };
  } catch (err) {
    client.closeWs();
    return { ok: false, analyze, uploadResult, built, error: err.message || String(err) };
  }
}

module.exports = {
  analyzeImageSendRequirements,
  uploadImageByTemplate,
  buildImagePayloadFromManualSample,
  sendImage,
  collectImageLikeFields,
};
