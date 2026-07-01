/**
 * 千帆 apppush WS 鉴权帧（连接后 action=auth, type=1 → ACK type=129）
 */
const crypto = require('crypto');

function makeTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

function pickCookieValue(cookie, name) {
  const re = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`);
  const m = String(cookie || '').match(re);
  return m ? decodeURIComponent(m[1]) : '';
}

function shopTitleMatches(rowTitle, shopTitle) {
  if (!shopTitle) return true;
  if (!rowTitle) return false;
  const a = String(rowTitle).trim();
  const b = String(shopTitle).trim();
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

function pickLatestWsAuthSample(rows, shopTitle = '') {
  let last = null;
  for (const row of rows || []) {
    if (row.kind !== 'ws_frame') continue;
    if (row.direction !== 'sent') continue;
    if (row.action !== 'auth' || Number(row.type) !== 1) continue;
    if (!row.payloadJson?.body?.sid) continue;
    if (shopTitle && row.shopTitle && !shopTitleMatches(row.shopTitle, shopTitle)) continue;
    last = row.payloadJson;
  }
  return last;
}

function pickLatestWsHandshake(rows, shopTitle = '') {
  let last = null;
  for (const row of rows || []) {
    if (row.kind !== 'ws_handshake') continue;
    if (row.phase !== 'request') continue;
    if (shopTitle && row.shopTitle && !shopTitleMatches(row.shopTitle, shopTitle)) continue;
    last = row;
  }
  return last;
}

function buildWsAuthBody(shopConfig, options = {}) {
  const tpl = shopConfig?.ws?.authTemplate?.body || shopConfig?.manualSamples?.wsAuthPayload?.body || {};
  const sid =
    options.sid ||
    tpl.sid ||
    shopConfig?.manualSamples?.wsAuthPayload?.body?.sid ||
    shopConfig?.httpAuthHeaders?.authorization ||
    '';
  const uid = options.uid || tpl.uid || '';
  const device = { ...(tpl.device || {}) };

  if (!device.deviceId) {
    device.deviceId = pickCookieValue(shopConfig?.cookie, 'webId') || makeTraceId().slice(0, 24);
  }
  if (!device.fingerprint) {
    device.fingerprint = String(pickCookieValue(shopConfig?.cookie, 'loadts') || Date.now());
  }

  return {
    uid,
    device: {
      platform: 'browser',
      os: 'web',
      osVersion: '10.0',
      deviceName: 'Chrome',
      appVersion: '128.0.6613.186',
      userAgent: shopConfig?.userAgent || '',
      ...device,
    },
    domain: tpl.domain || 'cs',
    extra: tpl.extra || JSON.stringify({ appName: 'walle-eva', appVersion: '1.37.5', 'User-Agent': 'not-browser-ua' }),
    sid: String(sid || '').trim(),
    authType: tpl.authType || 'generic',
  };
}

function buildWsAuthFrame(shopConfig, seq, options = {}) {
  const body = buildWsAuthBody(shopConfig, options);
  const traceId = options.traceId || makeTraceId();
  return {
    header: {
      sTime: Date.now(),
      seq: Number(seq) || 1,
      type: 1,
      contentType: 'json',
      bizId: 10,
      action: 'auth',
      traceId,
    },
    body,
  };
}

function parseAuthAckFrame(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const hdr = parsed.header || {};
  const body = parsed.body || {};
  if (String(hdr.action || '') !== 'auth') return null;
  if (Number(hdr.type) !== 129) return null;
  if (body.code === 0) {
    return {
      ok: true,
      channelId: body.data?.channelId || '',
      traceId: hdr.traceId || '',
      ack: parsed,
    };
  }
  if (body.code != null && body.code !== 0) {
    return { ok: false, error: new Error(body.msg || `auth code ${body.code}`), code: body.code };
  }
  return null;
}

function cleanWsHandshakeHeaders(headers = {}, cookie = '', userAgent = '', origin = '') {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lower = String(k).toLowerCase();
    if (lower.startsWith('sec-websocket')) continue;
    if (['host', 'connection', 'upgrade', 'content-length', 'accept-encoding', 'pragma', 'cache-control'].includes(lower)) {
      continue;
    }
    out[k] = v;
  }
  if (cookie && !out.Cookie) out.Cookie = cookie;
  if (userAgent && !out['User-Agent']) out['User-Agent'] = userAgent;
  if (origin && !out.Origin) out.Origin = origin;
  return out;
}

module.exports = {
  buildWsAuthFrame,
  buildWsAuthBody,
  parseAuthAckFrame,
  pickLatestWsAuthSample,
  pickLatestWsHandshake,
  cleanWsHandshakeHeaders,
  makeTraceId,
};
