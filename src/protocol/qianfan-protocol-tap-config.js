/**
 * 从协议抓包 JSONL 刷新纯协议配置（不依赖 CDP bridge）
 */
const fs = require('fs');
const path = require('path');
const { resolveProjectRoot } = require('../shared/app-root');
const { normalizeImpaasHttpHeaders } = require('./qianfan-protocol-auth');
const {
  pickLatestWsAuthSample,
  pickLatestWsHandshake,
  cleanWsHandshakeHeaders,
} = require('./qianfan-protocol-ws-auth');
const {
  pickMaxWsSeqFromTap,
  pickImpaasSendWsUrlFromTap,
  pickApppushWsUrlFromTap,
  resolveProtocolWsEndpoints,
  isImpaasSendWsUrl,
  isApppushWsUrl,
} = require('./qianfan-protocol-ws-routing');

const MESSAGE_LIST_URL = 'https://edith.xiaohongshu.com/api/impaas/message/user/list';

function shopTitleMatches(rowTitle, shopTitle) {
  if (!shopTitle) return true;
  if (!rowTitle) return false;
  const a = String(rowTitle).trim();
  const b = String(shopTitle).trim();
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

function tapDebugDir() {
  return path.join(resolveProjectRoot(), 'logs', 'debug');
}

function listTapLogFiles() {
  const dir = tapDebugDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^qianfan-protocol-tap-\d{4}-\d{2}-\d{2}\.jsonl$/i.test(f))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function readTapRows(maxFiles = 2, maxLinesPerFile = 8000) {
  const rows = [];
  for (const filePath of listTapLogFiles().slice(0, maxFiles)) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines.slice(-maxLinesPerFile)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // ignore
      }
    }
  }
  return rows;
}

function pickLatestMessageListRequest(rows, options = {}) {
  const preferAppCid = String(options.preferAppCid || '').trim();
  let last = null;
  let preferred = null;
  for (const row of rows) {
    if (row.kind !== 'http_request') continue;
    const url = String(row.url || '');
    if (!url.includes('/api/impaas/message/user/list') || url.includes('/batch')) continue;
    last = row;
    if (preferAppCid && String(row.body || '').includes(preferAppCid)) {
      preferred = row;
    }
  }
  return preferred || last;
}

function buildWsUrlByRequestId(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const reqId = String(row.requestId || '').trim();
    const url = String(row.url || row.wsUrl || '').trim();
    if (!reqId || !url) continue;
    if (row.kind === 'ws_created' || row.kind === 'ws_handshake') {
      map.set(reqId, url);
    }
    if (row.kind === 'ws_frame' && url) {
      map.set(reqId, url);
    }
  }
  return map;
}

function pickLatestTextSendSample(rows, shopTitle = '', preferReceiverUid = '') {
  const urlByReq = buildWsUrlByRequestId(rows);
  let last = null;
  let lastRow = null;
  let preferred = null;
  let preferredRow = null;
  for (const row of rows) {
    if (row.kind !== 'ws_frame') continue;
    if (row.direction !== 'sent') continue;
    if (shopTitle && row.shopTitle && !shopTitleMatches(row.shopTitle, shopTitle)) continue;
    if (row.action !== '/message/send' || Number(row.type) !== 3) continue;
    if (!row.payloadJson?.body?.contentInfo) continue;
    last = row.payloadJson;
    lastRow = row;
    const uid = row.payloadJson?.body?.receiverAppUids?.[0] || '';
    if (preferReceiverUid && uid.includes(preferReceiverUid)) {
      preferred = row.payloadJson;
      preferredRow = row;
    }
  }
  const pick = preferred || last;
  const pickRow = preferredRow || lastRow;
  if (!pick) return null;
  const wsUrl =
    String(pickRow?.wsUrl || '').trim() ||
    urlByReq.get(String(pickRow?.requestId || '')) ||
    '';
  return { payload: pick, wsUrl, requestId: pickRow?.requestId || '' };
}

function applyTapToShopConfig(shopConfig, options = {}) {
  const shopTitle = String(options.shopTitle || shopConfig?.shopTitle || '').trim();
  const fanfanReceiver = '60213afd00000000010055fd';
  const preferAppCid = String(
    options.preferAppCid || shopConfig?.testTarget?.appCid || ''
  ).trim();
  const rows = readTapRows(options.maxFiles || 2);
  const textSample = pickLatestTextSendSample(rows, shopTitle, fanfanReceiver);
  const authSample = pickLatestWsAuthSample(rows, shopTitle);
  const wsHandshake = pickLatestWsHandshake(rows, shopTitle);
  const listReq = pickLatestMessageListRequest(rows, {
    preferAppCid: preferAppCid || textSample?.payload?.body?.appCid || '',
  });
  const written = [];

  const out = JSON.parse(JSON.stringify(shopConfig || {}));
  if (!out.shopTitle && shopTitle) out.shopTitle = shopTitle;

  if (listReq?.url) {
    let body = {};
    try {
      body = JSON.parse(listReq.body || listReq.bodyTemplate || '{}');
    } catch {
      body = {};
    }
    body.cursor = -1;
    body.direction = false;
    if (!body.count) body.count = 20;
    if (!body.limit) body.limit = 20;
    const headers = normalizeImpaasHttpHeaders(listReq.headers || {});
    out.httpTemplates = out.httpTemplates || {};
    out.httpTemplates.messageList = {
      url: listReq.url,
      method: listReq.method || 'POST',
      headers,
      body,
    };
    if (headers.authorization) {
      out.httpAuthHeaders = { authorization: headers.authorization };
    }
    if (listReq.headers?.['User-Agent']) out.userAgent = listReq.headers['User-Agent'];
    written.push('httpTemplates.messageList', 'httpAuthHeaders');
  }

  if (textSample?.payload) {
    out.manualSamples = out.manualSamples || {};
    out.manualSamples.textSendPayload = textSample.payload;
    if (textSample.payload.header?.seq) out.lastSeq = Number(textSample.payload.header.seq);
    if (textSample.payload.body?.appCid) {
      out.testTarget = out.testTarget || {};
      out.testTarget.appCid = textSample.payload.body.appCid;
      out.testTarget.receiverAppUids =
        textSample.payload.body.receiverAppUids || out.testTarget.receiverAppUids;
      out.testTarget.buyerNick = out.testTarget.buyerNick || '饭饭';
    }
    if (textSample.wsUrl && (isImpaasSendWsUrl(textSample.wsUrl) || isApppushWsUrl(textSample.wsUrl))) {
      out.ws = out.ws || {};
      out.ws.sendUrl = textSample.wsUrl;
      out.wsUrlFromManualSend = textSample.wsUrl;
    }
    written.push('manualSamples.textSendPayload', 'testTarget');
  }

  const maxSeq = pickMaxWsSeqFromTap(rows, shopTitle);
  if (maxSeq > Number(out.lastSeq || 0)) out.lastSeq = maxSeq;

  out.ws = out.ws || {};
  const endpoints = resolveProtocolWsEndpoints(out, rows);
  if (endpoints.sendUrl) out.ws.sendUrl = endpoints.sendUrl;
  if (endpoints.apppushUrl) out.ws.apppushUrl = endpoints.apppushUrl;
  if (endpoints.listenUrl) {
    out.ws.listenUrl = endpoints.listenUrl;
    if (!out.ws.url || /apppush/i.test(out.ws.url)) out.ws.url = endpoints.listenUrl;
  }
  if (endpoints.sendUrl || endpoints.apppushUrl) {
    written.push('ws.sendUrl', 'ws.apppushUrl', 'ws.listenUrl');
  }

  if (authSample) {
    out.ws = out.ws || {};
    out.ws.authTemplate = authSample;
    out.manualSamples = out.manualSamples || {};
    out.manualSamples.wsAuthPayload = authSample;
    if (authSample.body?.sid && !out.httpAuthHeaders?.authorization) {
      out.httpAuthHeaders = { authorization: authSample.body.sid };
    }
    written.push('ws.authTemplate', 'manualSamples.wsAuthPayload');
  }

  if (wsHandshake?.requestHeaders || wsHandshake?.headers) {
    out.ws = out.ws || {};
    out.ws.handshakeHeaders = cleanWsHandshakeHeaders(
      wsHandshake.requestHeaders || wsHandshake.headers || {},
      out.cookie || '',
      out.userAgent || '',
      out.origin || ''
    );
    const hsHeaders = wsHandshake.requestHeaders || wsHandshake.headers || {};
    if (hsHeaders['User-Agent']) out.userAgent = hsHeaders['User-Agent'];
    if (hsHeaders.Origin) out.origin = hsHeaders.Origin;
    written.push('ws.handshakeHeaders');
  }

  return {
    config: out,
    writtenFields: written,
    tapRows: rows,
    wsEndpoints: endpoints,
    listReq: Boolean(listReq),
    textSample: Boolean(textSample?.payload),
    authSample: Boolean(authSample),
    wsHandshake: Boolean(wsHandshake),
  };
}

module.exports = {
  readTapRows,
  pickLatestMessageListRequest,
  pickLatestTextSendSample,
  applyTapToShopConfig,
  listTapLogFiles,
  shopTitleMatches,
};
