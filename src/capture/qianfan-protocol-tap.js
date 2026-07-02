/**
 * 千帆客服台协议抓包（旁路）— HTTP / WS / 握手全量记录，供纯协议逆向
 * 开启：config.wxbot-new.json → qianfanDebug.protocolTapEnabled=true
 * 或环境变量 QIANFAN_PROTOCOL_TAP=1
 */
const fs = require('fs');
const path = require('path');
const config = require('../wechat/wxbot-new-config');
const { resolveProjectRoot } = require('../shared/app-root');
const { parseMaybeJson, extractBuyerMessagesFromWsPayload } = require('../chat-parse');
const { println } = require('../utils');

const TAP_URL_RE =
  /xiaohongshu|longlink|impaas|walle|edith|ark\.xiaohongshu|qianfan|fulfillment|login2?\.|passport|customer\/login|\/sso|account\.xiaohongshu|sns\/web\/v\d+\/login|qrcode|scan\/login/i;
const STATIC_ASSET_RE = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|css|map)(\?|$)/i;
const CONSOLE_NOISE_URL_RE =
  /fe-static\.xhscdn\.com|apm-fe\.xiaohongshu\.com|spider-tracker\.xiaohongshu\.com|apm-track/i;
const LOGIN_API_URL_RE =
  /customer\.xiaohongshu|login2?\.xiaohongshu|passport|\/cas\/|qrcode|scan\/login|sns\/web.*login|service-ticket|\/sso|account\.xiaohongshu/i;

const pendingHttpBodies = new Map();
const tapStateByShop = new Map();

function isProtocolTapEnabled() {
  const qd = config.qianfanDebug || {};
  if (process.env.QIANFAN_PROTOCOL_TAP === '1') return true;
  if (process.env.QIANFAN_PROTOCOL_TAP === '0') return false;
  return qd.protocolTapEnabled === true;
}

function tapDebugDir() {
  const dir = path.join(resolveProjectRoot(), 'logs', 'debug');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tapLogPath() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(tapDebugDir(), `qianfan-protocol-tap-${y}-${m}-${day}.jsonl`);
}

function headersToObject(headers) {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    const out = {};
    for (const h of headers) {
      if (h?.name) out[h.name] = h.value;
    }
    return out;
  }
  return { ...headers };
}

function extractCookieFromHeaders(headers) {
  const obj = headersToObject(headers);
  return String(obj.Cookie || obj.cookie || '').trim();
}

function cookieKeyPreview(cookie) {
  const keys = [];
  for (const seg of String(cookie || '').split(';')) {
    const piece = seg.trim();
    const eq = piece.indexOf('=');
    if (eq > 0) keys.push(piece.slice(0, eq).trim());
  }
  return [...new Set(keys)].slice(0, 24);
}

function isLoginOrAuthUrl(url) {
  const u = String(url || '').toLowerCase();
  return (
    u.includes('/login') ||
    u.includes('passport') ||
    u.includes('/auth') ||
    u.includes('/sso') ||
    u.includes('login.xiaohongshu') ||
    u.includes('login2.xiaohongshu') ||
    u.includes('account.xiaohongshu') ||
    u.includes('qrcode') ||
    u.includes('scan/login') ||
    u.includes('customer/login')
  );
}

function detectTapPhase(url, shopTitle = '') {
  const u = String(url || '').toLowerCase();
  if (isLoginOrAuthUrl(u) || u.includes('autologin')) return 'login';
  if (u.includes('walle.xiaohongshu.com/cstools')) return 'shop';
  if (/xiaohongshu|longlink|impaas|walle|edith/i.test(u)) return 'qianfan';
  if (String(shopTitle || '').includes('登录')) return 'login';
  return 'other';
}

function extractSetCookieHeaders(headers) {
  const obj = headersToObject(headers);
  const raw = obj['Set-Cookie'] || obj['set-cookie'] || '';
  if (Array.isArray(raw)) return raw.join('; ');
  return String(raw || '');
}

function detectLoginMilestone(url, method, headers, bodyText, responseBody) {
  const u = String(url || '').toLowerCase();
  const hints = [];
  const setCookie = extractSetCookieHeaders(headers);
  if (setCookie && /(?:^|;\s*)a1=/i.test(setCookie)) hints.push('set_cookie_a1');
  if (setCookie && /access-token-walle/i.test(setCookie)) hints.push('set_cookie_walle_token');
  if (setCookie && /web_session/i.test(setCookie)) hints.push('set_cookie_web_session');
  if (/login|passport|sso|auth|qrcode|scan|customer\.xiaohongshu|\/cas\//i.test(u)) hints.push('login_api');
  const merged = `${bodyText || ''}\n${responseBody || ''}`;
  if (/access-token|customer\.eva\.AT-/i.test(merged)) hints.push('access_token_in_body');
  if (/\"sid\"\s*:|authorization.*a1:/i.test(merged)) hints.push('sid_or_auth_in_body');
  if (/channelId|ws\.auth|deviceId/i.test(merged)) hints.push('ws_auth_fields');
  return [...new Set(hints)];
}

function isTapRelevantUrl(url) {
  const u = String(url || '');
  if (!u || STATIC_ASSET_RE.test(u)) return false;
  if (/^data:|^blob:|^chrome-extension:/i.test(u)) return false;
  return TAP_URL_RE.test(u);
}

function shopLabel(bridge) {
  return String(bridge?.shopTitle || bridge?.pageTitle || '店铺').trim();
}

function bridgePhase(bridge, url = '') {
  return bridge?.phase || detectTapPhase(url || bridge?.pageUrl || '', shopLabel(bridge));
}

function createPseudoBridge(pageInfo = {}) {
  const pageUrl = String(pageInfo.url || '');
  const shopTitle =
    String(pageInfo.shopTitle || pageInfo.title || '').trim() ||
    (isLoginOrAuthUrl(pageUrl) ? '登录页' : '未命名页面');
  return {
    shopTitle,
    pageTitle: String(pageInfo.title || pageInfo.pageTitle || '').trim(),
    pageUrl,
    phase: detectTapPhase(pageUrl, shopTitle),
    wsUrls: new Map(),
    wsHandshakeHeaders: new Map(),
    client: null,
    isGlobalTap: true,
  };
}

function getShopTapState(bridge) {
  const key = shopLabel(bridge);
  if (!tapStateByShop.has(key)) {
    tapStateByShop.set(key, { http: 0, ws: 0, buyer: 0, startedAt: Date.now() });
  }
  return tapStateByShop.get(key);
}

function appendTap(entry) {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
  try {
    fs.appendFileSync(tapLogPath(), `${line}\n`, 'utf8');
  } catch {
    // ignore disk errors
  }
}

function isLoginHighlightEntry(entry) {
  if (entry.kind === 'session_milestone') return true;
  if (entry.kind === 'cookie_snapshot') return true;
  if ((entry.loginHints || []).length) return true;
  const url = String(entry.url || '');
  if (LOGIN_API_URL_RE.test(url)) return true;
  if (entry.phase === 'login' && /\/api\//i.test(url) && !CONSOLE_NOISE_URL_RE.test(url)) return true;
  return false;
}

function shouldPrintTapConsole(entry) {
  const kind = entry.kind || 'event';
  if (kind === 'session_milestone' || kind === 'cookie_snapshot') return true;
  if (kind === 'ws_created' || kind === 'ws_handshake' || kind === 'ws_frame') return true;
  const url = String(entry.url || '');
  if (CONSOLE_NOISE_URL_RE.test(url)) return false;
  if (kind === 'http_response_meta') return isLoginHighlightEntry(entry);
  if (/\.js(\?|$)/i.test(url) && !isLoginHighlightEntry(entry)) return false;
  return isLoginHighlightEntry(entry);
}

function printTapConsole(entry) {
  if (!shouldPrintTapConsole(entry)) return;
  const shop = entry.shopTitle || '-';
  const kind = entry.kind || 'event';
  const tag = isLoginHighlightEntry(entry) ? '登录★' : shop;
  if (kind === 'http_request') {
    println(
      `[协议抓包][${tag}] HTTP ${entry.method} ${entry.url} cookieLen=${entry.cookieLength || 0} keys=${(entry.cookieKeysPreview || []).join(',')} bodyLen=${entry.bodyLength || 0}`
    );
    if (entry.bodyPreview) println(`  body: ${entry.bodyPreview}`);
    if (entry.cookie) println(`  Cookie: ${entry.cookie}`);
    if (entry.headers && Object.keys(entry.headers).length) {
      println(`  headers: ${JSON.stringify(entry.headers)}`);
    }
    return;
  }
  if (kind === 'http_response') {
    println(
      `[协议抓包][${tag}] HTTP ${entry.status} ${entry.url} respLen=${entry.responseBodyLength || 0}`
    );
    if (entry.responseBodyPreview) println(`  resp: ${entry.responseBodyPreview}`);
    return;
  }
  if (kind === 'ws_created') {
    println(`[协议抓包][${shop}] WS 创建 ${entry.url}`);
    return;
  }
  if (kind === 'ws_handshake') {
    println(`[协议抓包][${shop}] WS 握手 ${entry.url}`);
    if (entry.requestHeaders) println(`  wsReqHeaders: ${JSON.stringify(entry.requestHeaders)}`);
    if (entry.responseHeaders) println(`  wsRespHeaders: ${JSON.stringify(entry.responseHeaders)}`);
    return;
  }
  if (kind === 'ws_frame') {
    const action = entry.action || '';
    const buyer = entry.buyerMessageCount ? ` buyerMsgs=${entry.buyerMessageCount}` : '';
    println(
      `[协议抓包][${shop}][${entry.phase || '-'}] WS ${entry.direction} action=${action} type=${entry.type}${buyer} preview=${entry.payloadPreview || ''}`
    );
    if (entry.cookie) println(`  Cookie(ws): ${entry.cookie}`);
    if (entry.payloadJson) println(`  payload: ${JSON.stringify(entry.payloadJson)}`);
    else if (entry.payloadRaw) println(`  raw: ${entry.payloadRaw}`);
    return;
  }
  if (kind === 'cookie_snapshot') {
    const cs = entry.cookieSummary || {};
    println(
      `[协议抓包][登录★][Cookie] ${shop} reason=${entry.reason || '-'} len=${entry.cookieLength || 0} a1=${cs.hasA1} walle=${cs.hasWalleToken} ark=${cs.hasArkToken} keys=${(entry.cookieKeysPreview || []).slice(0, 10).join(',')}`
    );
    return;
  }
  println(`[协议抓包][${shop}] ${kind} ${JSON.stringify(entry).slice(0, 500)}`);
}

function recordTap(bridge, entry) {
  if (!isProtocolTapEnabled()) return;
  const shopTitle = shopLabel(bridge);
  const phase = entry.phase || bridgePhase(bridge, entry.url || entry.pageUrl || bridge?.pageUrl);
  const row = {
    shopTitle,
    phase,
    pageUrl: entry.pageUrl || bridge?.pageUrl || '',
    ...entry,
  };
  appendTap(row);
  printTapConsole(row);
  const st = getShopTapState(bridge);
  if (entry.kind === 'http_request' || entry.kind === 'http_response') st.http += 1;
  if (entry.kind === 'ws_frame' || entry.kind === 'ws_created' || entry.kind === 'ws_handshake') {
    st.ws += 1;
  }
  if (entry.buyerMessageCount) st.buyer += entry.buyerMessageCount;
}

function maybeTapHttpRequest(bridge, params) {
  if (!isProtocolTapEnabled()) return;
  const request = params?.request || {};
  const url = String(request.url || '');
  if (!isTapRelevantUrl(url)) return;

  const headers = headersToObject(request.headers);
  const cookie = extractCookieFromHeaders(headers);
  const postData = request.postData || '';
  const bodyText = typeof postData === 'string' ? postData : JSON.stringify(postData);

  const requestId = String(params?.requestId || '');
  if (requestId) {
    pendingHttpBodies.set(requestId, { shopTitle: shopLabel(bridge), url, method: request.method, at: Date.now() });
  }

  recordTap(bridge, {
    kind: 'http_request',
    requestId,
    method: String(request.method || 'GET').toUpperCase(),
    url,
    headers,
    cookie,
    cookieLength: cookie.length,
    cookieKeysPreview: cookieKeyPreview(cookie),
    body: bodyText,
    bodyLength: bodyText.length,
    bodyPreview: bodyText.slice(0, 1200),
    loginHints: detectLoginMilestone(url, request.method, headers, bodyText, ''),
  });
}

function maybeTapHttpResponse(bridge, params) {
  if (!isProtocolTapEnabled()) return;
  const response = params?.response || {};
  const url = String(response.url || params?.url || '');
  const requestId = String(params?.requestId || '');
  if (requestId && pendingHttpBodies.has(requestId)) {
    const prev = pendingHttpBodies.get(requestId);
    pendingHttpBodies.set(requestId, { ...prev, status: Number(response.status || 0) });
  }
  if (!isTapRelevantUrl(url)) return;
  recordTap(bridge, {
    kind: 'http_response_meta',
    requestId: String(params?.requestId || ''),
    url,
    status: Number(response.status || 0),
    headers: headersToObject(response.headers),
  });
}

async function maybeTapHttpLoadingFinished(bridge, params) {
  if (!isProtocolTapEnabled()) return;
  const requestId = String(params?.requestId || '');
  const meta = pendingHttpBodies.get(requestId);
  if (!meta) return;
  pendingHttpBodies.delete(requestId);

  const client = bridge?.client;
  if (!client?.Network?.getResponseBody) return;

  try {
    const bodyResult = await client.Network.getResponseBody({ requestId });
    const text = bodyResult?.base64Encoded
      ? Buffer.from(bodyResult.body || '', 'base64').toString('utf8')
      : String(bodyResult?.body || '');
    recordTap(bridge, {
      kind: 'http_response',
      requestId,
      url: meta.url,
      method: meta.method,
      status: meta.status,
      responseBody: text,
      responseBodyLength: text.length,
      responseBodyPreview: text.slice(0, 2000),
      loginHints: detectLoginMilestone(meta.url, meta.method, {}, '', text),
    });
    try {
      const { shouldTriggerCookieSnapshot, scheduleTapCookieSnapshot } = require('./qianfan-protocol-tap-cookie');
      if (shouldTriggerCookieSnapshot(meta.url, text)) {
        scheduleTapCookieSnapshot(bridge, 'login_http_response', { networkHeaderWaitMs: 1500 });
      }
    } catch {
      // ignore cookie snapshot scheduling errors
    }
  } catch {
    // body may be unavailable
  }
}

function maybeTapWsCreated(bridge, params) {
  if (!isProtocolTapEnabled()) return;
  const url = String(params?.url || '');
  if (!url) return;
  recordTap(bridge, {
    kind: 'ws_created',
    requestId: String(params?.requestId || ''),
    url,
  });
}

function maybeTapWsHandshakeRequest(bridge, requestId, request, url) {
  if (!isProtocolTapEnabled()) return;
  const reqHeaders = headersToObject(request?.headers);
  const cookie = extractCookieFromHeaders(reqHeaders);
  recordTap(bridge, {
    kind: 'ws_handshake',
    phase: 'request',
    requestId: String(requestId || ''),
    url: String(url || ''),
    requestHeaders: reqHeaders,
    cookie,
    cookieLength: cookie.length,
    cookieKeysPreview: cookieKeyPreview(cookie),
  });
}

function maybeTapWsHandshakeResponse(bridge, requestId, response, url) {
  if (!isProtocolTapEnabled()) return;
  recordTap(bridge, {
    kind: 'ws_handshake',
    phase: 'response',
    requestId: String(requestId || ''),
    url: String(url || ''),
    status: Number(response?.status || 0),
    responseHeaders: headersToObject(response?.headers),
  });
}

function maybeTapWsFrame(bridge, payload, direction, requestId) {
  if (!isProtocolTapEnabled()) return;
  const raw = String(payload || '');
  const wsUrl = String(bridge?.wsUrls?.get(requestId) || '');
  const parsed = parseMaybeJson(raw);
  const hdr = parsed?.header || {};
  const action = String(hdr.action || '');

  let buyerMessages = [];
  if (parsed && (action === '/sync/unreliable' || action.includes('/message/'))) {
    try {
      buyerMessages = extractBuyerMessagesFromWsPayload(parsed, shopLabel(bridge));
    } catch {
      buyerMessages = [];
    }
  }

  const hs = bridge?.wsHandshakeHeaders?.get(requestId);
  const cookie = hs?.requestHeaders ? extractCookieFromHeaders(hs.requestHeaders) : '';

  recordTap(bridge, {
    kind: 'ws_frame',
    direction,
    requestId: String(requestId || ''),
    wsUrl,
    action,
    type: hdr.type,
    serviceId: hdr.serviceId,
    seq: hdr.seq,
    payloadRaw: parsed ? undefined : raw.slice(0, 4000),
    payloadJson: parsed || null,
    payloadPreview: parsed
      ? JSON.stringify({
          action: hdr.action,
          type: hdr.type,
          appCid: parsed?.body?.appCid,
          contentType: parsed?.body?.contentInfo?.contentType,
          content: String(parsed?.body?.contentInfo?.content || '').slice(0, 120),
        })
      : raw.slice(0, 200),
    buyerMessageCount: buyerMessages.length,
    buyerMessagesPreview: buyerMessages.slice(0, 5).map((m) => ({
      buyerNick: m.buyerNick,
      text: String(m.text || '').slice(0, 120),
      appCid: m.appCid,
      msgId: m.msgId,
    })),
    cookie,
    cookieLength: cookie.length,
    cookieKeysPreview: cookieKeyPreview(cookie),
  });
}

function appendTapSessionMilestone(entry) {
  recordTap(
    { shopTitle: entry.shopTitle || 'SESSION', phase: entry.phase || 'login', pageUrl: entry.pageUrl || '' },
    { kind: 'session_milestone', ...entry }
  );
}

function writeTapSessionManifest(manifest) {
  const outPath = path.join(
    tapDebugDir(),
    `qianfan-protocol-tap-session-${Date.now()}.json`
  );
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return outPath;
}

function getProtocolTapStatus() {
  const shops = [...tapStateByShop.entries()].map(([shopTitle, st]) => ({
    shopTitle,
    ...st,
  }));
  return {
    enabled: isProtocolTapEnabled(),
    logPath: tapLogPath(),
    shops,
    pendingHttpBodies: pendingHttpBodies.size,
  };
}

function bundleProtocolTap(options = {}) {
  const logPath = tapLogPath();
  if (!fs.existsSync(logPath)) {
    return { ok: false, error: 'log_not_found', logPath };
  }
  const sinceMs = Number(options.sinceMs || 10 * 60 * 1000);
  const cutoff = Date.now() - sinceMs;
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  const rows = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      const t = Date.parse(row.time || '');
      if (!Number.isNaN(t) && t >= cutoff) rows.push(row);
    } catch {
      // skip
    }
  }

  const outPath = path.join(
    tapDebugDir(),
    `qianfan-protocol-tap-bundle-${Date.now()}.json`
  );
  const bundle = {
    generatedAt: new Date().toISOString(),
    sourceLog: logPath,
    sinceMs,
    rowCount: rows.length,
    rows,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  return { ok: true, outPath, rowCount: rows.length };
}

let tapStartupLogged = false;

function logProtocolTapStartup() {
  if (!isProtocolTapEnabled() || tapStartupLogged) return;
  tapStartupLogged = true;
  println(`[协议抓包] 已开启 → ${tapLogPath()}（控制台 + JSONL 全量记录 URL/headers/Cookie/body/WS）`);
}

module.exports = {
  isProtocolTapEnabled,
  isLoginOrAuthUrl,
  detectTapPhase,
  createPseudoBridge,
  logProtocolTapStartup,
  recordTap,
  maybeTapHttpRequest,
  maybeTapHttpResponse,
  maybeTapHttpLoadingFinished,
  maybeTapWsCreated,
  maybeTapWsHandshakeRequest,
  maybeTapWsHandshakeResponse,
  maybeTapWsFrame,
  getProtocolTapStatus,
  bundleProtocolTap,
  tapLogPath,
  appendTapSessionMilestone,
  writeTapSessionManifest,
};
