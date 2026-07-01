#!/usr/bin/env node
/**
 * 全自动纯协议测试：Cookie 注入 → live 合并 → listen / list / send（默认 dry-run，--really-send 才真发饭饭）
 * Cookie 仅写入 gitignore 的 local 配置，不进仓库。
 */
const fs = require('fs');
const path = require('path');
const { QianfanProtocolClient } = require('../src/protocol/qianfan-protocol-client');
const {
  summarizeCookie,
  localConfigPath,
  probeShopConfig,
} = require('../src/protocol/qianfan-protocol-config');
const {
  loadLiveSnapshot,
  buildLiveProtocolConfig,
  mergeShopIntoLocal,
  saveLocalProtocolConfig,
  readExistingLocalConfig,
  disableFixtureShops,
  getLiveApiBaseUrl,
} = require('../src/protocol/qianfan-live-context-extractor');
const { writeProtocolReport, getGitCommit } = require('../src/protocol/qianfan-protocol-report');
const { resolveProjectRoot } = require('../src/shared/app-root');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.186 Safari/537.36';

function parseArgs(argv) {
  const out = {
    shop: '祥钰珠宝',
    buyer: '饭饭',
    cookie: String(process.env.QIANFAN_PROTOCOL_COOKIE || '').trim(),
    cookieFile: '',
    origin: 'https://walle.xiaohongshu.com',
    referer: 'https://walle.xiaohongshu.com/',
    listenMs: 15000,
    reallySend: false,
    skipLive: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--shop') out.shop = String(argv[++i] || '').trim();
    else if (a === '--buyer') out.buyer = String(argv[++i] || '饭饭').trim();
    else if (a === '--cookie') out.cookie = String(argv[++i] || '').trim();
    else if (a === '--cookie-file') out.cookieFile = String(argv[++i] || '').trim();
    else if (a === '--origin') out.origin = String(argv[++i] || '').trim();
    else if (a === '--listen-ms') out.listenMs = Number(argv[++i]) || 15000;
    else if (a === '--really-send') out.reallySend = true;
    else if (a === '--skip-live') out.skipLive = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  if (out.cookieFile && fs.existsSync(out.cookieFile)) {
    out.cookie = fs.readFileSync(out.cookieFile, 'utf8').trim();
  }
  return out;
}

function stripStaleHttpAuth(headers) {
  const out = { ...(headers || {}) };
  for (const k of Object.keys(out)) {
    if (/^authorization$/i.test(k)) delete out[k];
    if (/^x-b3-traceid$/i.test(k)) delete out[k];
  }
  return out;
}

function scoreWsUrl(url) {
  const u = String(url || '');
  let s = 0;
  if (/impaas/i.test(u)) s += 100;
  if (/walle\.xiaohongshu\.com/i.test(u)) s += 80;
  if (/edith\.xiaohongshu\.com/i.test(u)) s += 60;
  if (/longlink/i.test(u)) s += 50;
  if (/apppush/i.test(u)) s -= 80;
  return s;
}

function collectWsUrlCandidates(config, snapshot) {
  const set = new Set();
  const add = (url) => {
    const u = String(url || '').trim();
    if (u && /^wss?:\/\//i.test(u)) set.add(u);
  };
  add(config?.ws?.url);
  for (const c of snapshot?.wsCandidates || []) add(c.url);
  add(snapshot?.wsUrlFromManualSend);
  for (const row of snapshot?.allWsUrls || []) add(row.url);
  return [...set].sort((a, b) => scoreWsUrl(b) - scoreWsUrl(a));
}

function mergeCookieStrings(...parts) {
  const map = new Map();
  for (const part of parts) {
    for (const seg of String(part || '').split(';')) {
      const piece = seg.trim();
      if (!piece) continue;
      const eq = piece.indexOf('=');
      if (eq <= 0) continue;
      const name = piece.slice(0, eq).trim();
      const value = piece.slice(eq + 1).trim();
      const prev = map.get(name);
      if (!prev || value.length > prev.length) map.set(name, value);
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 千帆客服台 HTTP/WS：以 walle live cookie 为底，只追加 ark 域额外 key，避免 xsecappid 被 fulfillment 覆盖 */
function buildCsCookie(liveCookie, userCookie, fallbackCookie = '') {
  const WALLE_CS_KEYS = new Set([
    'a1',
    'webId',
    'web_session',
    'xsecappid',
    'access-token-walle.xiaohongshu.com',
    'walle-eva-auth',
    'walle-eva-bUserId',
    'x-user-id',
    'gid',
    'acw_tc',
    'websectiga',
    'sec_poison_id',
    'loadts',
  ]);
  const base = String(liveCookie || fallbackCookie || '').trim();
  if (!base) return String(userCookie || '').trim();

  const baseMap = new Map();
  for (const seg of base.split(';')) {
    const piece = seg.trim();
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    baseMap.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
  }
  for (const seg of String(userCookie || '').split(';')) {
    const piece = seg.trim();
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    const name = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (WALLE_CS_KEYS.has(name) && baseMap.has(name)) continue;
    if (!baseMap.has(name) || value.length > (baseMap.get(name) || '').length) {
      baseMap.set(name, value);
    }
  }
  for (const k of WALLE_CS_KEYS) {
    const fromBase = base.split(';').find((s) => s.trim().startsWith(`${k}=`));
    if (fromBase) {
      const eq = fromBase.indexOf('=');
      baseMap.set(k, fromBase.slice(eq + 1).trim());
    }
  }
  if (!baseMap.get('xsecappid') || String(baseMap.get('xsecappid')).includes('ark')) {
    const walleXsec = base.split(';').find((s) => /xsecappid=walle/i.test(s.trim()));
    if (walleXsec) {
      const eq = walleXsec.indexOf('=');
      baseMap.set('xsecappid', walleXsec.slice(eq + 1).trim());
    }
  }
  return [...baseMap.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function preferMessageListTemplate(built, existing) {
  const builtTpl = built?.httpTemplates?.messageList;
  const existTpl = existing?.httpTemplates?.messageList;
  if (existTpl?.url?.includes('/list/batch')) return existTpl;
  if (builtTpl?.url?.includes('/list/batch')) return builtTpl;
  if (builtTpl?.url) return builtTpl;
  return existTpl;
}

function ensureBatchMessageListTemplate(config) {
  const tpl = config?.httpTemplates?.messageList;
  const appCid = String(config?.testTarget?.appCid || tpl?.body?.appCid || '').trim();
  if (!appCid) return config;
  if (tpl?.url?.includes('/list/batch') && Array.isArray(tpl?.body?.appCids)) return config;
  config.httpTemplates = config.httpTemplates || {};
  config.httpTemplates.messageList = {
    url: 'https://edith.xiaohongshu.com/api/impaas/message/user/list/batch',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': config.userAgent || DEFAULT_UA,
      Referer: config.referer || 'https://walle.xiaohongshu.com/',
      Origin: config.origin || 'https://walle.xiaohongshu.com',
      ...(tpl?.headers || {}),
    },
    body: {
      appCids: [appCid],
      count: 10,
    },
  };
  config.httpTemplates.messageList.headers = stripStaleHttpAuth(config.httpTemplates.messageList.headers);
  return config;
}

function applyCookieToConfig(config, cookie, meta = {}) {
  const c = String(cookie || '').trim();
  if (!c) return config;
  config.cookie = c;
  config.userAgent = config.userAgent || DEFAULT_UA;
  config.origin = meta.origin || config.origin || 'https://walle.xiaohongshu.com';
  config.referer = meta.referer || config.referer || 'https://walle.xiaohongshu.com/';
  config.ws = config.ws || { url: '', headers: {} };
  config.ws.headers = {
    Cookie: c,
    'User-Agent': config.userAgent,
    Origin: config.origin,
    ...(config.ws.headers || {}),
  };
  config.ws.headers.Cookie = c;
  if (config.httpTemplates?.messageList?.headers) {
    config.httpTemplates.messageList.headers = stripStaleHttpAuth(config.httpTemplates.messageList.headers);
  }
  return config;
}

function findExistingShopConfig(shopTitle) {
  const all = readExistingLocalConfig();
  return all.find((s) => s && s.shopTitle === shopTitle) || null;
}

function mergeWithExistingLiveConfig(built, existing) {
  if (!existing) return built;
  const out = JSON.parse(JSON.stringify(built));
  if (!out.ws?.url && existing.ws?.url) out.ws.url = existing.ws.url;
  const msgTpl = preferMessageListTemplate(built, existing);
  if (msgTpl?.url) {
    out.httpTemplates = out.httpTemplates || {};
    out.httpTemplates.messageList = msgTpl;
  }
  if (!Object.keys(out.manualSamples?.textSendPayload || {}).length && existing.manualSamples?.textSendPayload) {
    out.manualSamples.textSendPayload = existing.manualSamples.textSendPayload;
  }
  if (!out.testTarget?.appCid && existing.testTarget?.appCid) {
    out.testTarget.appCid = existing.testTarget.appCid;
    out.testTarget.receiverAppUids = existing.testTarget.receiverAppUids || [];
  }
  return out;
}

async function pickBestWsUrl(client, candidates, listenMs) {
  const tried = [];
  for (const url of candidates) {
    client.wsUrl = url;
    client.shopConfig.ws = client.shopConfig.ws || {};
    client.shopConfig.ws.url = url;
    const listen = await client.connectWs({ listenMs: Math.min(listenMs, 8000) });
    const actions = listen.actions || {};
    const bizScore =
      (actions['/sync/unreliable'] || 0) +
      (actions['/message/send'] || 0) * 2 +
      (actions['/message/read/from/one'] || 0);
    tried.push({ url, listen, bizScore });
    if (listen.connected && bizScore > 0) {
      return { url, listen, tried, reason: 'biz_frames' };
    }
  }
  const connected = tried.find((t) => t.listen.connected);
  if (connected) {
    return { url: connected.url, listen: connected.listen, tried, reason: 'first_connected' };
  }
  return { url: candidates[0] || '', listen: tried[0]?.listen || null, tried, reason: 'fallback_first' };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法: node scripts/run-qianfan-protocol-auto.js [options]');
    console.log('  --shop 祥钰珠宝  --cookie "..." | --cookie-file path');
    console.log('  --really-send  仅发给 testTarget.buyerNick=饭饭');
    console.log('  环境变量 QIANFAN_PROTOCOL_COOKIE');
    process.exit(0);
  }

  if (!args.cookie) {
    console.error('[auto] 缺少 Cookie：--cookie 或 QIANFAN_PROTOCOL_COOKIE 或 --cookie-file');
    process.exit(1);
  }

  console.log('[auto] shop=', args.shop, 'api=', getLiveApiBaseUrl());
  const previewSummary = summarizeCookie(args.cookie);
  console.log('[auto] input cookie length=', args.cookie.length, 'hasWalle=', previewSummary.hasWalleToken);

  let snapshot = null;
  let built = null;
  if (!args.skipLive) {
    try {
      const loaded = await loadLiveSnapshot(args.shop, { refresh: true });
      if (loaded.ok && loaded.snapshot?.ok) {
        snapshot = loaded.snapshot;
        built = buildLiveProtocolConfig(snapshot, { shopTitle: args.shop, buyerNick: args.buyer });
        console.log('[auto] live snapshot OK enrichNotes=', snapshot.enrichNotes || []);
      }
    } catch (err) {
      console.warn('[auto] live snapshot skip:', err.message || err);
    }
  }

  let config = built?.config || findExistingShopConfig(args.shop);
  if (!config) {
    console.error('[auto] 无 live/本地配置，请先 export-live 或提供完整 local');
    process.exit(1);
  }
  config = mergeWithExistingLiveConfig(config, findExistingShopConfig(args.shop));
  const liveCookie = String(snapshot?.cookieSources?.mergedNetworkHeaderCookie || '').trim();
  const existingCookie = String(findExistingShopConfig(args.shop)?.cookie || '').trim();
  const mergedCookie = buildCsCookie(liveCookie, args.cookie, existingCookie);
  config = applyCookieToConfig(config, mergedCookie, { origin: args.origin, referer: args.referer });
  config = ensureBatchMessageListTemplate(config);
  config.shopTitle = args.shop;
  config.enabled = true;
  config.testTarget = config.testTarget || {};
  config.testTarget.buyerNick = args.buyer;

  const wsCandidates = collectWsUrlCandidates(config, snapshot);
  console.log('[auto] WS 候选:', wsCandidates);

  const existing = readExistingLocalConfig().filter((s) => s?.shopTitle !== args.shop);
  const merged = mergeShopIntoLocal(existing, config, args.shop, true);
  disableFixtureShops(merged.shops, args.shop);
  if (wsCandidates[0]) {
    merged.shop.ws.url = wsCandidates[0];
    merged.shop.ws.headers.Cookie = args.cookie;
  }
  saveLocalProtocolConfig(merged.shops);
  console.log('[auto] 已更新', localConfigPath());
  console.log('[auto] merged cookie length=', merged.shop.cookie?.length, summarizeCookie(merged.shop.cookie));

  const shop = merged.shop;
  const client = new QianfanProtocolClient(shop);
  const report = {
    testName: 'auto-protocol',
    shopTitle: args.shop,
    gitCommit: getGitCommit(),
    cookieSummary: summarizeCookie(merged.shop.cookie),
    wsCandidates,
    steps: {},
  };

  report.steps.probe = probeShopConfig(shop);

  const wsPick = wsCandidates.length
    ? await pickBestWsUrl(client, wsCandidates, args.listenMs)
    : { url: '', listen: null, tried: [], reason: 'no_candidates' };
  if (wsPick.url) {
    shop.ws.url = wsPick.url;
    client.wsUrl = wsPick.url;
    merged.shop.ws.url = wsPick.url;
    saveLocalProtocolConfig(merged.shops);
  }
  report.steps.listen = wsPick.listen || { ok: false, error: 'no_listen' };
  report.steps.wsPick = { url: wsPick.url, reason: wsPick.reason, tried: (wsPick.tried || []).map((t) => ({
    url: t.url,
    connected: t.listen?.connected,
    bizScore: t.bizScore,
    actions: t.listen?.actions,
  })) };

  const appCid = String(shop.testTarget?.appCid || '').trim();
  report.steps.messageList = await client.fetchMessageList(appCid);
  console.log('[auto] messageList ok=', report.steps.messageList.ok, 'status=', report.steps.messageList.status, 'count=', report.steps.messageList.messageCount);

  const receiverAppUids = shop.testTarget?.receiverAppUids || [];
  const text = shop.testTarget?.text || '纯协议文字测试';
  report.steps.textDryRun = await client.sendText({
    appCid,
    receiverAppUids,
    text,
    reallySend: false,
  });

  if (args.reallySend) {
    if (shop.testTarget?.buyerNick !== '饭饭') {
      report.steps.reallySend = { skipped: true, error: '仅允许发给饭饭' };
    } else if (!wsPick.url) {
      report.steps.reallySend = { skipped: true, error: '无 ws.url' };
    } else {
      await client.openWsForSend();
      report.steps.reallySend = await client.sendText({
        appCid,
        receiverAppUids,
        text,
        reallySend: true,
        verifyList: true,
      });
      client.closeWs();
      console.log('[auto] really-send ok=', report.steps.reallySend.ok, 'msgId=', report.steps.reallySend.ack?.msgId);
    }
  } else {
    report.steps.reallySend = { skipped: true, reason: 'dry-run default' };
  }

  report.conclusions = {
    pureListenReady: Boolean(wsPick.listen?.connected && wsPick.listen?.ok !== false),
    pureHttpPullReady: Boolean(report.steps.messageList?.ok && report.steps.messageList?.status === 200),
    pureTextSendDryReady: Boolean(report.steps.textDryRun?.ok && report.steps.textDryRun?.dryRun),
    pureTextSendReallyReady: Boolean(report.steps.reallySend?.ok && report.steps.reallySend?.ack?.msgId),
  };

  if (!report.conclusions.pureHttpPullReady) {
    report.blockers = report.blockers || [];
    if (report.steps.messageList?.status === 401) {
      report.blockers.push('cookie_expired_or_wrong_domain: 需要千帆客服台 access-token-walle，ark 履约 Cookie 不能单独用于 impaas');
    }
    if (wsPick.url && /apppush/i.test(wsPick.url)) {
      report.blockers.push('ws_wrong_channel: apppush 长链可连接但无 impaas 业务帧，需从客服台页面捕获 impaas/longlink WS');
    }
  }

  const outPath = writeProtocolReport(report);
  console.log('\n========== 全自动纯协议报告 ==========');
  console.log('报告:', outPath);
  console.log('listen:', report.conclusions.pureListenReady, 'list:', report.conclusions.pureHttpPullReady);
  console.log('dry-run:', report.conclusions.pureTextSendDryReady, 'really-send:', report.conclusions.pureTextSendReallyReady);
  console.log('WS 选用:', wsPick.url || '(无)', '原因:', wsPick.reason);
  if (report.steps.messageList?.messagesPreview?.length) {
    console.log('买家消息 preview:', JSON.stringify(report.steps.messageList.messagesPreview.slice(0, 3), null, 2));
  }
  console.log('========================================\n');

  const ok =
    report.conclusions.pureHttpPullReady &&
    report.conclusions.pureTextSendDryReady &&
    (!args.reallySend || report.conclusions.pureTextSendReallyReady);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[auto] FAILED', err.stack || err.message || err);
  process.exit(1);
});
