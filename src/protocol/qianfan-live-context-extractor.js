/**
 * 千帆纯协议 — 从运行中 CDP Bridge 导出 live 协议上下文（旁路模块）
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { summarizeCookie, localConfigPath, exampleConfigPath } = require('./qianfan-protocol-config');
const { getLocalApiPort } = require('../qianfan-local-api');
const { resolveProjectRoot } = require('../shared/app-root');
const { buyerNickMatches } = require('../qianfan-data-store');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const WS_HEADER_DROP = new Set([
  'host',
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
  'content-length',
  'accept-encoding',
]);
const IMAGE_UPLOAD_URL_RE = /upload|file|image|media|material|oss/i;

function getGitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: resolveProjectRoot() }).trim();
  } catch {
    return 'unknown';
  }
}

function reportTimestamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day}-${hh}${mm}${ss}`;
}

function isNonempty(val) {
  if (val == null) return false;
  if (typeof val === 'string') return val.trim().length > 0;
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === 'object') return Object.keys(val).length > 0;
  return true;
}

function pickHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const target = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === target) return String(v || '');
  }
  return '';
}

function cleanHttpTemplateHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lower = String(k).toLowerCase();
    if (['cookie', 'content-length', 'host', 'connection', 'accept-encoding'].includes(lower)) continue;
    out[k] = v;
  }
  return out;
}

function cleanWsHeaders(headers, cookie, userAgent, origin) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (WS_HEADER_DROP.has(String(k).toLowerCase())) continue;
    out[k] = v;
  }
  out.Cookie = cookie;
  if (userAgent) out['User-Agent'] = userAgent;
  if (origin) out.Origin = origin;
  return out;
}

function parseBodyTemplate(bodyTemplate) {
  const raw = String(bodyTemplate || '').trim();
  if (!raw) return { body: {}, bodyRaw: '' };
  try {
    return { body: JSON.parse(raw), bodyRaw: raw };
  } catch {
    return { body: {}, bodyRaw: raw };
  }
}

function isTextSendPayload(payload) {
  const hdr = payload?.header || {};
  const body = payload?.body || {};
  return (
    hdr.action === '/message/send' &&
    Number(hdr.type) === 3 &&
    Number(body.contentInfo?.contentType) === 1 &&
    body.appCid &&
    Array.isArray(body.receiverAppUids) &&
    body.receiverAppUids.length
  );
}

function getLiveApiBaseUrl() {
  const port = getLocalApiPort();
  return `http://127.0.0.1:${port}`;
}

async function fetchJson(url, timeoutMs = 8000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const json = await res.json();
  return { ok: res.ok, status: res.status, json };
}

async function fetchLiveShopsViaApi() {
  const base = getLiveApiBaseUrl();
  let status = 0;
  let json = {};
  try {
    const res = await fetchJson(`${base}/api/qianfan/protocol/live-shops`);
    status = res.status;
    json = res.json;
    if (res.ok) return json;
  } catch (err) {
    const health = await fetchJson(`${base}/api/health`).catch(() => null);
    if (health?.ok && health.json?.ok) {
      const stale = new Error(
        '本地 API 已运行，但缺少 /api/qianfan/protocol/* 接口。请关闭机器人，重新 npm run build 后启动最新版 EXE（或 npm start）。'
      );
      stale.code = 'diagnostic_api_stale_build';
      throw stale;
    }
    const unavailable = new Error(err.message || 'diagnostic_api_unavailable');
    unavailable.code = 'diagnostic_api_unavailable';
    throw unavailable;
  }

  if (status === 404) {
    const health = await fetchJson(`${base}/api/health`).catch(() => null);
    if (health?.ok && health.json?.ok) {
      const stale = new Error(
        '本地 API 已运行，但缺少 /api/qianfan/protocol/* 接口。请关闭机器人，重新 npm run build 后启动最新版 EXE（或 npm start）。'
      );
      stale.code = 'diagnostic_api_stale_build';
      throw stale;
    }
  }

  const err = new Error(json?.message || `diagnostic_api_unavailable HTTP ${status}`);
  err.code = 'diagnostic_api_unavailable';
  throw err;
}

async function fetchLiveSnapshotViaApi(shopTitle, options = {}) {
  const base = getLiveApiBaseUrl();
  const refresh = options.refresh !== false ? '1' : '0';
  const url = `${base}/api/qianfan/protocol/snapshot?shopTitle=${encodeURIComponent(shopTitle)}&refresh=${refresh}`;
  const { ok, status, json } = await fetchJson(url, Number(options.timeoutMs || 15000));
  if (!ok) {
    const err = new Error(json?.message || json?.error || `snapshot failed HTTP ${status}`);
    err.code = json?.error || 'diagnostic_api_unavailable';
    throw err;
  }
  return json;
}

function tryDirectLiveShops() {
  try {
    const { getAllQianfanBridges, buildQianfanProtocolSnapshot } = require('../qianfan-ws-bridge');
    const bridges = getAllQianfanBridges();
    return {
      ok: true,
      mode: 'direct',
      shops: bridges.map((bridge) => {
        const snap = buildQianfanProtocolSnapshot(bridge.shopTitle);
        return summarizeLiveShopRow(snap);
      }),
    };
  } catch (err) {
    return { ok: false, mode: 'direct', error: err.message || String(err), shops: [] };
  }
}

function tryDirectSnapshot(shopTitle) {
  try {
    const { buildQianfanProtocolSnapshot } = require('../qianfan-ws-bridge');
    return { ok: true, mode: 'direct', snapshot: buildQianfanProtocolSnapshot(shopTitle) };
  } catch (err) {
    return { ok: false, mode: 'direct', error: err.message || String(err) };
  }
}

async function listLiveProtocolShops(options = {}) {
  if (options.preferDirect) {
    const direct = tryDirectLiveShops();
    if (direct.ok && direct.shops.length) return direct;
  }
  try {
    const api = await fetchLiveShopsViaApi();
    return { ok: true, mode: 'http', shops: api.shops || [], apiBase: getLiveApiBaseUrl() };
  } catch (err) {
    const direct = tryDirectLiveShops();
    if (direct.ok && direct.shops.length) return direct;
    return {
      ok: false,
      mode: 'unavailable',
      shops: [],
      error: err.code || err.message || 'process_memory_unreachable',
    };
  }
}

async function loadLiveSnapshot(shopTitle, options = {}) {
  if (options.preferDirect) {
    const direct = tryDirectSnapshot(shopTitle);
    if (direct.ok && direct.snapshot?.ok) return { ok: true, mode: 'direct', snapshot: direct.snapshot };
  }
  try {
    const api = await fetchLiveSnapshotViaApi(shopTitle);
    return { ok: true, mode: 'http', snapshot: api.snapshot || api };
  } catch (err) {
    const direct = tryDirectSnapshot(shopTitle);
    if (direct.ok && direct.snapshot?.ok) return { ok: true, mode: 'direct', snapshot: direct.snapshot };
    return { ok: false, error: err.code || err.message || 'process_memory_unreachable' };
  }
}

function summarizeLiveShopRow(snapshot) {
  const cookie = String(snapshot?.cookieSources?.mergedNetworkHeaderCookie || '').trim();
  const summary = summarizeCookie(cookie);
  return {
    shopTitle: snapshot?.shopTitle || '',
    normalizedShopTitle: snapshot?.normalizedShopTitle || '',
    bridgeExists: snapshot?.ok === true,
    cdpReady: Boolean(snapshot?.cdpReady),
    wsCandidateCount: Array.isArray(snapshot?.wsCandidates) ? snapshot.wsCandidates.length : 0,
    httpTemplateCount: snapshot?.httpTemplates ? Object.keys(snapshot.httpTemplates).length : 0,
    hasMessageList: Boolean(snapshot?.lastMessageListRequest?.url),
    hasWsHandshake: Boolean(snapshot?.wsHandshake?.headers?.length),
    cookieSummary: summary,
  };
}

function pickWsCandidate(snapshot) {
  const candidates = Array.isArray(snapshot?.wsCandidates) ? [...snapshot.wsCandidates] : [];
  candidates.sort(
    (a, b) =>
      Number(b.seenMessageSend) - Number(a.seenMessageSend) ||
      Number(b.seenBuyerSync) - Number(a.seenBuyerSync) ||
      Number(b.seenImpaasTraffic) - Number(a.seenImpaasTraffic) ||
      b.score - a.score ||
      b.lastActivityAt - a.lastActivityAt
  );
  return candidates[0] || null;
}

function findHandshakeForRequest(snapshot, requestId, url) {
  const headers = snapshot?.wsHandshake?.headers || [];
  const exact = headers.find((h) => h.requestId === requestId);
  if (exact) return exact;
  return headers.find((h) => h.url === url) || null;
}

function pickTextSendSample(snapshot, appCid) {
  const cid = String(appCid || '').trim();
  const byCid = snapshot?.lastManualSendByAppCid || {};
  if (cid && byCid[cid]?.payload && isTextSendPayload(byCid[cid].payload)) {
    return { payload: byCid[cid].payload, source: 'lastManualSendByAppCid' };
  }
  if (snapshot?.lastManualSendAny && isTextSendPayload(snapshot.lastManualSendAny)) {
    return { payload: snapshot.lastManualSendAny, source: 'lastManualSendAny' };
  }
  for (const sample of Object.values(byCid)) {
    if (sample?.payload && isTextSendPayload(sample.payload)) {
      return { payload: sample.payload, source: 'lastManualSendByAppCid.other' };
    }
  }
  return { payload: null, source: '' };
}

function pickImageSendSample(snapshot, appCid) {
  const cid = String(appCid || '').trim();
  const byCid = snapshot?.lastManualImageSendByAppCid || {};
  if (cid && byCid[cid]?.payload) return { payload: byCid[cid].payload, source: 'lastManualImageSendByAppCid' };
  if (snapshot?.lastManualImageSendAny) {
    return { payload: snapshot.lastManualImageSendAny, source: 'lastManualImageSendAny' };
  }
  for (const sample of Object.values(byCid)) {
    if (sample?.payload) return { payload: sample.payload, source: 'lastManualImageSendByAppCid.other' };
  }
  return { payload: null, source: '' };
}

function pickMessageListTemplate(snapshot) {
  if (snapshot?.lastMessageListRequest?.url) {
    return { template: snapshot.lastMessageListRequest, source: 'lastMessageListRequest' };
  }
  const templates = snapshot?.httpTemplates || {};
  const keys = Object.keys(templates).filter((k) => /message\/user\/list|latest\/content|unchecked\/ai\/msg/i.test(k));
  keys.sort((a, b) => {
    const score = (k) => {
      if (k.includes('/api/impaas/message/user/list/batch')) return 100;
      if (k.includes('/api/impaas/message/user/list')) return 90;
      return 10;
    };
    return score(b) - score(a);
  });
  if (keys.length) return { template: templates[keys[0]], source: `httpTemplates.${keys[0]}` };
  return { template: null, source: '' };
}

function pickImageUploadTemplate(snapshot) {
  const templates = snapshot?.httpTemplates || {};
  const hits = Object.values(templates).filter((tpl) => {
    const url = String(tpl?.url || '');
    return IMAGE_UPLOAD_URL_RE.test(url);
  });
  if (!hits.length) return { template: null, source: '' };
  hits.sort((a, b) => String(b.url).length - String(a.url).length);
  return { template: hits[0], source: 'httpTemplates.imageUpload' };
}

function pickAppCid(snapshot, options = {}) {
  if (options.appCid) return { value: String(options.appCid).trim(), source: '--app-cid' };

  const manualKeys = Object.keys(snapshot?.lastManualSendByAppCid || {});
  if (manualKeys.length === 1) {
    return { value: manualKeys[0], source: 'lastManualSendByAppCid.single' };
  }

  const buyer = String(options.buyerNick || '').trim();
  for (const ctx of snapshot?.sessionContexts || []) {
    if (buyer && ctx?.buyerNick && buyerNickMatches(ctx.buyerNick, buyer) && ctx.appCid) {
      return { value: String(ctx.appCid), source: 'sessionContext.buyerNick' };
    }
  }

  const wsPick = pickWsCandidate(snapshot);
  if (wsPick?.appCids?.length === 1) {
    return { value: String(wsPick.appCids[0]), source: 'wsCandidates.single' };
  }

  if (manualKeys.length) {
    return { value: manualKeys[0], source: 'lastManualSendByAppCid.first' };
  }

  const ctx = (snapshot?.sessionContexts || [])[0];
  if (ctx?.appCid) return { value: String(ctx.appCid), source: 'sessionContext.recent' };

  return { value: '', source: '' };
}

function pickReceiverAppUids(snapshot, appCid, textSample, options = {}) {
  const fromArg = Array.isArray(options.receiverAppUids)
    ? options.receiverAppUids.map((u) => String(u || '').trim()).filter(Boolean)
    : [];
  if (fromArg.length) return { value: fromArg, source: '--receiver-app-uid' };

  const fromSample = textSample?.payload?.body?.receiverAppUids;
  if (Array.isArray(fromSample) && fromSample.length) {
    return { value: [...fromSample], source: 'manualSamples.textSendPayload' };
  }

  for (const ctx of snapshot?.sessionContexts || []) {
    if (appCid && ctx?.appCid === appCid && Array.isArray(ctx.receiverAppUids) && ctx.receiverAppUids.length) {
      return { value: [...ctx.receiverAppUids], source: 'sessionContext.receiverAppUids' };
    }
  }

  for (const row of snapshot?.receiverCache || []) {
    if (appCid && row.key.endsWith(`::${appCid}`) && row.receiverAppUids?.length) {
      return { value: [...row.receiverAppUids], source: 'receiverCache' };
    }
  }

  return { value: [], source: '' };
}

function buildLiveProtocolConfig(snapshot, options = {}) {
  const buyerNick = String(options.buyerNick || '饭饭').trim();
  const cookie = String(snapshot?.cookieSources?.mergedNetworkHeaderCookie || '').trim();
  const wsCandidate = pickWsCandidate(snapshot);
  const handshake = wsCandidate
    ? findHandshakeForRequest(snapshot, wsCandidate.requestId, wsCandidate.url)
    : null;
  const reqHeaders = handshake?.requestHeaders || {};
  const userAgent = pickHeader(reqHeaders, 'User-Agent') || DEFAULT_UA;
  const origin = pickHeader(reqHeaders, 'Origin') || 'https://walle.xiaohongshu.com';
  const referer = 'https://walle.xiaohongshu.com/';

  const appCidPick = pickAppCid(snapshot, options);
  const textSample = pickTextSendSample(snapshot, appCidPick.value);
  const receiverPick = pickReceiverAppUids(snapshot, appCidPick.value, textSample, options);
  const messageListPick = pickMessageListTemplate(snapshot);
  const imageUploadPick = pickImageUploadTemplate(snapshot);
  const imageSample = pickImageSendSample(snapshot, appCidPick.value);

  const messageListBody = messageListPick.template
    ? parseBodyTemplate(messageListPick.template.bodyTemplate)
    : { body: {}, bodyRaw: '' };

  const missingFields = [];
  if (!cookie) missingFields.push('no_cookie');
  if (!wsCandidate?.url) missingFields.push('no_ws_candidate');
  if (!handshake?.requestHeaders) missingFields.push('no_ws_handshake_headers');
  if (!messageListPick.template?.url) missingFields.push('no_message_list_template');
  if (!appCidPick.value) missingFields.push('no_app_cid');
  if (!receiverPick.value.length) missingFields.push('no_receiver_app_uids');
  if (!textSample.payload) missingFields.push('no_manual_send_sample');
  if (!imageSample.payload) missingFields.push('missing manualSamples.imageSendPayload');
  if (!imageUploadPick.template?.url) missingFields.push('missing imageUpload template');

  const cookieSummary = summarizeCookie(cookie);
  if (!cookieSummary.hasA1) missingFields.push('cookie_missing_a1');
  if (!cookieSummary.hasAccessToken) missingFields.push('cookie_missing_access_token');

  const config = {
    shopTitle: snapshot.shopTitle || options.shopTitle,
    enabled: true,
    cookie,
    userAgent,
    origin,
    referer,
    ws: {
      url: wsCandidate?.url || '',
      headers: cleanWsHeaders(reqHeaders, cookie, userAgent, origin),
    },
    httpTemplates: {
      messageList: messageListPick.template
        ? {
            url: messageListPick.template.url,
            method: messageListPick.template.method || 'POST',
            headers: cleanHttpTemplateHeaders(messageListPick.template.headers),
            body: messageListBody.body,
            ...(messageListBody.bodyRaw && !Object.keys(messageListBody.body).length
              ? { bodyRaw: messageListBody.bodyRaw }
              : {}),
          }
        : { url: '', method: 'POST', headers: {}, body: {} },
      imageUpload: imageUploadPick.template
        ? {
            url: imageUploadPick.template.url,
            method: imageUploadPick.template.method || 'POST',
            headers: cleanHttpTemplateHeaders(imageUploadPick.template.headers),
            fieldName: 'file',
            extraFields: {},
          }
        : { url: '', method: 'POST', headers: {}, fieldName: 'file', extraFields: {} },
    },
    manualSamples: {
      textSendPayload: textSample.payload || {},
      imageSendPayload: imageSample.payload || {},
      imageUploadResponse: {},
    },
    testTarget: {
      buyerNick,
      appCid: appCidPick.value,
      receiverAppUids: receiverPick.value,
      text: '纯协议文字测试',
      imagePath: 'test-assets/qianfan-test-image.jpg',
    },
  };

  return {
    config,
    meta: {
      wsCandidate,
      wsSelectionReason: {
        seenMessageSend: Boolean(wsCandidate?.seenMessageSend),
        seenBuyerSync: Boolean(wsCandidate?.seenBuyerSync),
        seenImpaasTraffic: Boolean(wsCandidate?.seenImpaasTraffic),
        appCidMatched: Boolean(appCidPick.value && wsCandidate?.appCids?.includes(appCidPick.value)),
      },
      hasWsHandshakeHeaders: Boolean(handshake?.requestHeaders),
      messageListSource: messageListPick.source,
      appCidSource: appCidPick.source,
      receiverAppUidsSource: receiverPick.source,
      textSendPayloadSource: textSample.source,
      imageSendPayloadSource: imageSample.source,
      imageUploadSource: imageUploadPick.source,
      missingFields: [...new Set(missingFields)],
      cookieSummary,
      recentWsHeartbeatFrames: snapshot?.recentWsHeartbeatFrames || [],
    },
  };
}

function readExistingLocalConfig() {
  const p = localConfigPath();
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function mergeShopIntoLocal(existingAll, config, shopTitle, force = false) {
  const idx = existingAll.findIndex((s) => s && s.shopTitle === shopTitle);
  const existing = idx >= 0 ? existingAll[idx] : null;
  const written = [];

  const mergeField = (target, key, value) => {
    if (!isNonempty(value)) return;
    if (force || !isNonempty(target[key])) {
      target[key] = value;
      written.push(key);
    }
  };

  const shop = existing ? JSON.parse(JSON.stringify(existing)) : JSON.parse(JSON.stringify(config));
  mergeField(shop, 'shopTitle', config.shopTitle);
  shop.enabled = true;
  mergeField(shop, 'cookie', config.cookie);
  mergeField(shop, 'userAgent', config.userAgent);
  mergeField(shop, 'origin', config.origin);
  mergeField(shop, 'referer', config.referer);

  shop.ws = shop.ws || {};
  mergeField(shop.ws, 'url', config.ws?.url);
  shop.ws.headers = shop.ws.headers || {};
  for (const hk of ['Cookie', 'User-Agent', 'Origin']) {
    mergeField(shop.ws.headers, hk, config.ws?.headers?.[hk]);
  }

  shop.httpTemplates = shop.httpTemplates || {};
  if (config.httpTemplates?.messageList?.url && (force || !shop.httpTemplates.messageList?.url)) {
    shop.httpTemplates.messageList = config.httpTemplates.messageList;
    written.push('httpTemplates.messageList');
  }
  if (config.httpTemplates?.imageUpload?.url && (force || !shop.httpTemplates.imageUpload?.url)) {
    shop.httpTemplates.imageUpload = config.httpTemplates.imageUpload;
    written.push('httpTemplates.imageUpload');
  }

  shop.manualSamples = shop.manualSamples || {};
  if (isNonempty(config.manualSamples?.textSendPayload) && (force || !isNonempty(shop.manualSamples.textSendPayload))) {
    shop.manualSamples.textSendPayload = config.manualSamples.textSendPayload;
    written.push('manualSamples.textSendPayload');
  }
  if (isNonempty(config.manualSamples?.imageSendPayload) && (force || !isNonempty(shop.manualSamples.imageSendPayload))) {
    shop.manualSamples.imageSendPayload = config.manualSamples.imageSendPayload;
    written.push('manualSamples.imageSendPayload');
  }

  shop.testTarget = shop.testTarget || {};
  shop.testTarget.buyerNick = config.testTarget?.buyerNick || shop.testTarget.buyerNick || '饭饭';
  mergeField(shop.testTarget, 'appCid', config.testTarget?.appCid);
  if (config.testTarget?.receiverAppUids?.length && (force || !shop.testTarget.receiverAppUids?.length)) {
    shop.testTarget.receiverAppUids = config.testTarget.receiverAppUids;
    written.push('testTarget.receiverAppUids');
  }
  if (!shop.testTarget.text) shop.testTarget.text = '纯协议文字测试';
  if (!shop.testTarget.imagePath) shop.testTarget.imagePath = 'test-assets/qianfan-test-image.jpg';

  if (idx >= 0) existingAll[idx] = shop;
  else existingAll.push(shop);

  return { shops: existingAll, shop, writtenFields: written };
}

function disableFixtureShops(existingAll, keepShopTitle) {
  const keep = String(keepShopTitle || '').trim();
  for (const row of existingAll) {
    if (!row || row.shopTitle === keep) continue;
    if (String(row.shopTitle || '') === '测试店铺名称' || String(row.cookie || '').includes('fixture-a1-value')) {
      row.enabled = false;
    }
  }
  return existingAll;
}

function saveLocalProtocolConfig(shops) {
  const p = localConfigPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(shops, null, 2)}\n`, 'utf8');
  return p;
}

function writeLiveExportReport(report) {
  const dir = path.join(resolveProjectRoot(), 'logs', 'debug');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `qianfan-live-protocol-export-${reportTimestamp()}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return filePath;
}

function printNextSteps(shopTitle) {
  console.log('\n下一步请执行：');
  console.log('npm run qf:protocol:probe');
  console.log(`npm run qf:protocol:listen -- --shop "${shopTitle}" --listen-ms 30000`);
  console.log(`npm run qf:protocol:list -- --shop "${shopTitle}"`);
  console.log(`npm run qf:protocol:send-text -- --shop "${shopTitle}"`);
  console.log(`npm run qf:protocol:send-image -- --shop "${shopTitle}"`);
}

module.exports = {
  listLiveProtocolShops,
  loadLiveSnapshot,
  buildLiveProtocolConfig,
  summarizeLiveShopRow,
  mergeShopIntoLocal,
  saveLocalProtocolConfig,
  disableFixtureShops,
  readExistingLocalConfig,
  writeLiveExportReport,
  printNextSteps,
  getLiveApiBaseUrl,
  getGitCommit,
};
