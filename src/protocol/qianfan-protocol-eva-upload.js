/**
 * 千帆纯协议 — EVA 图片上传（permit + COS 分片）
 */
const fs = require('fs');
const path = require('path');

const PERMIT_BASE =
  'https://edith.xiaohongshu.com/api/eva/upload/permit?biz_name=cs&scene=feeva_img&file_count=1&version=1&source=web';
const IM_TOKEN_RE = /mario\.token\.[A-Za-z0-9]+/i;

function pickImTokenFromString(str) {
  const m = String(str || '').match(IM_TOKEN_RE);
  return m ? m[0] : '';
}

function extractImTokenFromUrl(url) {
  try {
    const fromQuery = new URL(String(url || '')).searchParams.get('im_token') || '';
    return pickImTokenFromString(fromQuery);
  } catch {
    return '';
  }
}

function pickImTokenFromUploadFlow(shopConfig) {
  const flow = shopConfig?.httpTemplates?.imageUploadFlow;
  if (!Array.isArray(flow)) return '';
  for (let i = flow.length - 1; i >= 0; i -= 1) {
    const step = flow[i];
    if (!String(step?.url || '').includes('/api/eva/upload/permit')) continue;
    const token = extractImTokenFromUrl(step.url);
    if (token) return token;
  }
  return '';
}

function resolveConfiguredImToken(shopConfig) {
  const direct = pickImTokenFromString(shopConfig?.imToken);
  if (direct) return direct;
  const fromTpl = extractImTokenFromUrl(shopConfig?.httpTemplates?.imageUpload?.url);
  if (fromTpl) return fromTpl;
  return pickImTokenFromUploadFlow(shopConfig);
}

function buildPermitUrl(imToken = '') {
  const token = String(imToken || '').trim();
  if (!token) return PERMIT_BASE;
  return `${PERMIT_BASE}&im_token=${encodeURIComponent(token)}`;
}

function buildPermitCandidates(shopConfig, imToken = '') {
  const seen = new Set();
  const list = [];
  const add = (url) => {
    const u = String(url || '').trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    list.push(u);
  };

  add(buildPermitUrl(imToken));
  add(shopConfig?.httpTemplates?.imageUpload?.url);

  const flow = shopConfig?.httpTemplates?.imageUploadFlow;
  if (Array.isArray(flow)) {
    for (let i = flow.length - 1; i >= 0; i -= 1) {
      const step = flow[i];
      if (String(step?.url || '').includes('/api/eva/upload/permit')) {
        add(step.url);
      }
    }
  }
  return list;
}

function shopHeaders(shopConfig, extra = {}) {
  const tpl = shopConfig?.httpTemplates?.imageUpload?.headers || {};
  const headers = {
    Cookie: shopConfig.cookie,
    'User-Agent': shopConfig.userAgent || tpl['User-Agent'],
    Origin: shopConfig.origin || 'https://walle.xiaohongshu.com',
    Referer: shopConfig.referer || tpl.Referer || 'https://walle.xiaohongshu.com/',
    Accept: 'application/json, text/plain, */*',
    ...(shopConfig.httpAuthHeaders || {}),
    ...tpl,
    ...extra,
  };
  headers.Cookie = shopConfig.cookie;
  delete headers.Authorization;
  return headers;
}

function parseXmlTag(xml, tag) {
  const m = String(xml || '').match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
  return m ? m[1] : '';
}

async function fetchImTokenFromWalle(shopConfig) {
  try {
    const res = await fetch('https://walle.xiaohongshu.com/', {
      method: 'GET',
      headers: shopHeaders(shopConfig),
      redirect: 'follow',
    });
    return pickImTokenFromString(await res.text());
  } catch {
    return '';
  }
}

async function resolveImToken(shopConfig) {
  const configured = resolveConfiguredImToken(shopConfig);
  if (configured) return configured;
  return fetchImTokenFromWalle(shopConfig);
}

async function fetchPermit(shopConfig) {
  let imToken = await resolveImToken(shopConfig);
  let candidates = buildPermitCandidates(shopConfig, imToken);
  if (!candidates.some((url) => url.includes('im_token='))) {
    if (!imToken) imToken = await fetchImTokenFromWalle(shopConfig);
    candidates = buildPermitCandidates(shopConfig, imToken);
  }

  const errors = [];
  for (const url of candidates) {
    const res = await fetch(url, { method: 'GET', headers: shopHeaders(shopConfig) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      errors.push(`${res.status} non-json`);
      continue;
    }
    const permit = json?.data?.uploadTempPermits?.[0];
    if (permit?.fileIds?.[0]) {
      return permit;
    }
    errors.push(json?.msg || json?.message || `HTTP ${res.status} ${text.slice(0, 160)}`);
  }

  const detail = errors.slice(0, 2).join(' | ');
  if (!imToken && !candidates.some((url) => url.includes('im_token='))) {
    throw new Error(
      detail
        ? `permit 失败（缺少 im_token）: ${detail}`
        : 'permit 失败：缺少 im_token，请确认千帆 Cookie 有效或在配置中保留 imageUploadFlow 抓包'
    );
  }
  throw new Error(detail || 'permit 未返回 fileId');
}

async function uploadImageBuffer(shopConfig, imageBuffer, { width = 0, height = 0 } = {}) {
  const permit = await fetchPermit(shopConfig);
  const fileId = String(permit.fileIds[0]);
  const token = String(permit.token || '');
  const uploadAddr = String(permit.uploadAddr || 'ros-upload.xiaohongshu.com');
  const baseUrl = `https://${uploadAddr}/${fileId}`;

  const initRes = await fetch(`${baseUrl}?uploads`, {
    method: 'POST',
    headers: shopHeaders(shopConfig, {
      'x-cos-security-token': token,
      'Content-Type': 'image/jpeg',
    }),
  });
  const initText = await initRes.text();
  const uploadId = parseXmlTag(initText, 'UploadId');
  if (!uploadId) {
    throw new Error('COS uploads 未返回 UploadId');
  }

  const putRes = await fetch(`${baseUrl}?partNumber=1&uploadId=${encodeURIComponent(uploadId)}`, {
    method: 'PUT',
    headers: shopHeaders(shopConfig, {
      'x-cos-security-token': token,
      'Content-Type': 'image/jpeg',
    }),
    body: imageBuffer,
  });
  if (!putRes.ok) {
    throw new Error(`COS PUT 失败 (${putRes.status})`);
  }
  const etag = String(putRes.headers.get('etag') || putRes.headers.get('ETag') || '').replace(/"/g, '');
  if (!etag) {
    throw new Error('COS PUT 未返回 ETag');
  }

  const completeXml = `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"${etag}"</ETag></Part></CompleteMultipartUpload>`;
  const completeRes = await fetch(`${baseUrl}?uploadId=${encodeURIComponent(uploadId)}`, {
    method: 'POST',
    headers: shopHeaders(shopConfig, {
      'x-cos-security-token': token,
      'Content-Type': 'application/xml',
    }),
    body: completeXml,
  });
  if (!completeRes.ok) {
    throw new Error(`COS complete 失败 (${completeRes.status})`);
  }

  return {
    ok: true,
    fileId,
    resource: {
      cloudType: Number(permit.cloudType || 4),
      bizName: 'cs',
      scene: 'feeva_img',
      fileId,
    },
    width,
    height,
    method: 'eva_permit_cos',
  };
}

function decodeBase64Image(imageBase64) {
  const raw = String(imageBase64 || '').trim();
  if (!raw) return null;
  const b64 = raw.includes(',') ? raw.split(',')[1] : raw;
  return Buffer.from(b64, 'base64');
}

async function uploadImageFromBase64(shopConfig, imageBase64, meta = {}) {
  const buf = decodeBase64Image(imageBase64);
  if (!buf || !buf.length) {
    return { ok: false, error: '无效 imageBase64' };
  }
  try {
    const result = await uploadImageBuffer(shopConfig, buf, meta);
    return result;
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function uploadImageFromPath(shopConfig, imagePath, meta = {}) {
  const abs = path.isAbsolute(imagePath) ? imagePath : path.resolve(process.cwd(), imagePath);
  if (!fs.existsSync(abs)) {
    return { ok: false, error: `图片不存在: ${abs}` };
  }
  const buf = fs.readFileSync(abs);
  try {
    return await uploadImageBuffer(shopConfig, buf, meta);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = {
  resolveImToken,
  buildPermitUrl,
  fetchPermit,
  uploadImageBuffer,
  uploadImageFromBase64,
  uploadImageFromPath,
};
