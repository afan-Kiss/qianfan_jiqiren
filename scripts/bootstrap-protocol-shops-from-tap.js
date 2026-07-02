#!/usr/bin/env node
/**
 * 从 protocol tap JSONL 提取三店纯协议配置并写入 local.json（全量替换，避免脏 merge）
 */
const fs = require('fs');
const { applyTapToShopConfig, listTapLogFiles } = require('../src/protocol/qianfan-protocol-tap-config');
const { saveLocalProtocolConfig } = require('../src/protocol/qianfan-live-context-extractor');
const { findProtocolShopConfig } = require('../src/protocol/qianfan-protocol-config');
const { pickLatestWsAuthSample, pickLatestWsHandshake, cleanWsHandshakeHeaders } = require('../src/protocol/qianfan-protocol-ws-auth');
const { pickMaxWsSeqFromTap } = require('../src/protocol/qianfan-protocol-ws-routing');
const { normalizeImpaasHttpHeaders } = require('../src/protocol/qianfan-protocol-auth');

const SHOPS = ['祥钰珠宝', '和田雅玉', 'XY祥钰珠宝'];
const FANFAN_UID = '60213afd00000000010055fd';
const FANFAN_RECEIVER = `1#2#2#${FANFAN_UID}`;
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) eva/1.2.6 Chrome/128.0.6613.186 Electron/32.2.8 Safari/537.36';

function readAllTapRows() {
  const rows = [];
  for (const filePath of listTapLogFiles().slice(0, 3)) {
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
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

function pickLatestMessageListRequest(rows, shopTitle) {
  let last = null;
  for (const row of rows) {
    if (row.shopTitle !== shopTitle || row.kind !== 'http_request') continue;
    const url = String(row.url || '');
    if (!url.includes('/message/user/list') || url.includes('/batch')) continue;
    last = row;
  }
  return last;
}

function extractFanfanFromHttp(rows, shopTitle) {
  let appCid = '';
  for (const row of rows) {
    if (row.shopTitle !== shopTitle || row.kind !== 'http_response') continue;
    const raw = String(row.responseBody || row.body || '');
    if (!raw.includes(FANFAN_UID) && !raw.includes('0055fd')) continue;
    const m = raw.match(/"appCid":"([^"]+)"/);
    if (m) appCid = m[1];
  }
  return appCid;
}

function extractTextSendToFanfan(rows, shopTitle) {
  let last = null;
  for (const row of rows) {
    if (row.kind !== 'ws_frame' || row.direction !== 'sent' || row.shopTitle !== shopTitle) continue;
    if (row.action !== '/message/send' || Number(row.type) !== 3) continue;
    const uid = row.payloadJson?.body?.receiverAppUids?.[0] || '';
    if (!uid.includes('0055fd') && !uid.includes(FANFAN_UID)) continue;
    last = row.payloadJson;
  }
  return last;
}

function sharedCookie() {
  try {
    return String(findProtocolShopConfig('祥钰珠宝', { allowIncomplete: true }).cookie || '').trim();
  } catch {
    return '';
  }
}

function buildShop(shopTitle, rows, cookie) {
  const shopRows = rows.filter((r) => r.shopTitle === shopTitle);
  const base = {
    shopTitle,
    enabled: true,
    cookie,
    userAgent: DEFAULT_UA,
    origin: 'https://walle.xiaohongshu.com',
    referer: 'https://walle.xiaohongshu.com/',
    ws: {
      url: 'wss://apppush-wss.xiaohongshu.com/longlink',
      apppushUrl: 'wss://apppush-wss.xiaohongshu.com/longlink',
      listenUrl: 'wss://apppush-wss.xiaohongshu.com/longlink',
      sendUrl: 'wss://apppush-wss.xiaohongshu.com/longlink',
      headers: { Cookie: cookie, 'User-Agent': DEFAULT_UA, Origin: 'https://walle.xiaohongshu.com' },
    },
    testTarget: { buyerNick: '饭饭', text: '纯协议文字测试', imagePath: 'test-assets/qianfan-test-image.jpg' },
    httpTemplates: {},
    manualSamples: {},
  };

  const applied = applyTapToShopConfig(base, { shopTitle, maxFiles: 3, maxLinesPerFile: 100000 });
  const config = applied.config;

  const wsAuth = pickLatestWsAuthSample(shopRows, shopTitle);
  const wsHandshake = pickLatestWsHandshake(shopRows, shopTitle);
  if (wsAuth) {
    config.ws.authTemplate = wsAuth;
    config.manualSamples.wsAuthPayload = wsAuth;
    config.httpAuthHeaders = { authorization: wsAuth.body.sid };
  }

  if (wsHandshake?.requestHeaders || wsHandshake?.headers) {
    config.ws.handshakeHeaders = cleanWsHandshakeHeaders(
      wsHandshake.requestHeaders || wsHandshake.headers || {},
      cookie,
      DEFAULT_UA,
      config.origin
    );
  }

  const listReq = pickLatestMessageListRequest(rows, shopTitle);
  if (listReq?.url) {
    let body = {};
    try {
      body = JSON.parse(listReq.body || '{}');
    } catch {
      body = {};
    }
    body.cursor = -1;
    body.direction = false;
    if (!body.count) body.count = 20;
    if (!body.limit) body.limit = 20;
    config.httpTemplates.messageList = {
      url: listReq.url,
      method: listReq.method || 'POST',
      headers: normalizeImpaasHttpHeaders(listReq.headers || {}),
      body,
    };
    const auth = config.httpTemplates.messageList.headers.authorization;
    if (auth) config.httpAuthHeaders = { authorization: auth };
  }

  const fanfanSend = extractTextSendToFanfan(rows, shopTitle);
  const fanfanAppCid = extractFanfanFromHttp(rows, shopTitle);

  if (fanfanSend?.body) {
    config.manualSamples.textSendPayload = fanfanSend;
    config.testTarget.appCid = fanfanSend.body.appCid;
    config.testTarget.receiverAppUids = fanfanSend.body.receiverAppUids || [FANFAN_RECEIVER];
  } else if (fanfanAppCid) {
    config.testTarget.appCid = fanfanAppCid;
    config.testTarget.receiverAppUids = [FANFAN_RECEIVER];
  }

  const maxSeq = pickMaxWsSeqFromTap(shopRows, shopTitle);
  if (maxSeq > 0) config.lastSeq = maxSeq;

  config.ws.sendUrl = config.ws.sendUrl || config.ws.apppushUrl || config.ws.url;
  config.ws.headers = { Cookie: cookie, 'User-Agent': DEFAULT_UA, Origin: config.origin };

  return config;
}

function main() {
  const rows = readAllTapRows();
  const cookie = sharedCookie();
  if (!cookie) {
    console.error('[bootstrap-tap] 缺少共享 cookie，请先导出祥钰珠宝配置');
    process.exit(1);
  }

  const shops = SHOPS.map((shopTitle) => buildShop(shopTitle, rows, cookie));
  saveLocalProtocolConfig(shops);

  for (const config of shops) {
    console.log(
      `[bootstrap-tap] ${config.shopTitle} uid=${config.ws?.authTemplate?.body?.uid || '-'} lastSeq=${config.lastSeq || 0} appCid=${String(config.testTarget?.appCid || '').slice(0, 52) || '(无)'} list=${Boolean(config.httpTemplates?.messageList?.url)}`
    );
  }
  console.log('[bootstrap-tap] 已全量写入 config/qianfan-protocol-shops.local.json（3 店）');
}

main();
