#!/usr/bin/env node
/**
 * 三店纯协议监听 + 饭饭新消息自动回复「亲亲」
 * WS 实时 + HTTP 兜底轮询，仅向白名单买家「饭饭」发送。
 */
const { findProtocolShopConfig } = require('../src/protocol/qianfan-protocol-config');
const { applyTapToShopConfig } = require('../src/protocol/qianfan-protocol-tap-config');
const { QianfanProtocolService } = require('../src/protocol/qianfan-protocol-service');
const {
  mergeShopIntoLocal,
  saveLocalProtocolConfig,
  readExistingLocalConfig,
  disableFixtureShops,
} = require('../src/protocol/qianfan-live-context-extractor');
const { isProtocolImSendAllowed } = require('../src/protocol/qianfan-protocol-send-guard');

const PROTOCOL_TEST_BUYER = '饭饭';
const { isIgnoredMessage, isWsBuyerCandidate, normalizeCreateAtMs } = require('../src/chat-parse');
const { resolveProtocolWsEndpoints } = require('../src/protocol/qianfan-protocol-ws-routing');

const DEFAULT_SHOPS = ['祥钰珠宝', '和田雅玉', 'XY祥钰珠宝'];
const REPLY_TEXT = '亲亲';
const FANFAN_RECEIVER = '1#2#2#60213afd00000000010055fd';

function parseArgs(argv) {
  const out = {
    shops: [...DEFAULT_SHOPS],
    httpPollMs: 30000,
    writeLocal: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--shop' || a === '-s') out.shops = [String(argv[++i] || '').trim()].filter(Boolean);
    else if (a === '--shops') {
      out.shops = String(argv[++i] || '')
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--http-poll-ms') out.httpPollMs = Number(argv[++i]) || out.httpPollMs;
    else if (a === '--write-local') out.writeLocal = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function ensureWsSendUrl(config) {
  const endpoints = resolveProtocolWsEndpoints(config);
  config.ws = config.ws || {};
  if (!endpoints.sendUrl && endpoints.apppushUrl) {
    config.ws.sendUrl = endpoints.apppushUrl;
    endpoints.sendUrl = endpoints.apppushUrl;
    endpoints.canSend = true;
  }
  if (!config.ws.listenUrl && endpoints.listenUrl) config.ws.listenUrl = endpoints.listenUrl;
  if (!config.ws.apppushUrl && endpoints.apppushUrl) config.ws.apppushUrl = endpoints.apppushUrl;
  if (!config.ws.url) config.ws.url = endpoints.listenUrl || endpoints.apppushUrl || config.ws.url;
  return endpoints;
}

function primeClientSendFromListen(client) {
  if (!client.wsSendUrl && client.wsListenUrl && /apppush/i.test(client.wsListenUrl)) {
    client.wsSendUrl = client.wsListenUrl;
    client.wsEndpoints = client.wsEndpoints || {};
    client.wsEndpoints.sendUrl = client.wsListenUrl;
  }
  if (client.wsListen && client.wsListen.readyState === 1 && client.wsAuthed) {
    client.ws = client.wsListen;
  }
}
function applyCookieToWsHeaders(config) {
  const cookie = String(config.cookie || '').trim();
  if (!cookie) return config;
  config.ws = config.ws || { url: 'wss://apppush-wss.xiaohongshu.com/longlink' };
  config.ws.headers = {
    Cookie: cookie,
    'User-Agent': config.userAgent || config.ws.headers?.['User-Agent'] || '',
    Origin: config.origin || 'https://walle.xiaohongshu.com',
    ...(config.ws.headers || {}),
  };
  config.ws.headers.Cookie = cookie;
  if (config.ws.handshakeHeaders) {
    config.ws.handshakeHeaders.Cookie = cookie;
  }
  return config;
}

function sharedCookieFromLocal() {
  try {
    const hit = findProtocolShopConfig('祥钰珠宝', { allowIncomplete: true });
    return String(hit?.cookie || '').trim();
  } catch {
    return '';
  }
}

async function buildShopConfig(shopTitle) {
  let base = null;
  try {
    base = findProtocolShopConfig(shopTitle, { allowIncomplete: true });
  } catch {
    base = {
      shopTitle,
      enabled: true,
      cookie: '',
      origin: 'https://walle.xiaohongshu.com',
      referer: 'https://walle.xiaohongshu.com/',
      ws: { url: 'wss://apppush-wss.xiaohongshu.com/longlink' },
      testTarget: { buyerNick: PROTOCOL_TEST_BUYER },
    };
  }

  if (!base.cookie) {
    const shared = sharedCookieFromLocal();
    if (shared) base.cookie = shared;
  }

  const tapApplied = applyTapToShopConfig(base, { shopTitle, maxFiles: 3, maxLinesPerFile: 100000 });
  const config = tapApplied.config;
  if (!config.testTarget?.buyerNick) {
    config.testTarget = config.testTarget || {};
    config.testTarget.buyerNick = PROTOCOL_TEST_BUYER;
  }
  config.shopTitle = shopTitle;
  config.enabled = true;
  ensureWsSendUrl(config);
  return applyCookieToWsHeaders(config);
}

function pickWatchAppCids(config, discovered = new Map()) {
  const set = new Set();
  const target = config?.testTarget || {};
  if (target.appCid) set.add(String(target.appCid).trim());
  const sample = config?.manualSamples?.textSendPayload?.body?.appCid;
  if (sample) set.add(String(sample).trim());
  for (const cid of discovered.keys()) set.add(cid);
  return [...set].filter(Boolean);
}

function rememberFanfanSession(config, discovered, msg) {
  const appCid = String(msg?.appCid || '').trim();
  if (!appCid) return;
  const receiver =
    String(msg?.senderAppUid || '').trim() ||
    (String(msg?.raw?.senderAppUid || '').trim());
  const row = {
    appCid,
    buyerNick: msg.buyerNick || PROTOCOL_TEST_BUYER,
    receiverAppUids: receiver ? [receiver] : config?.testTarget?.receiverAppUids || [],
  };
  discovered.set(appCid, row);
  if (isProtocolImSendAllowed(row.buyerNick) && (receiver.includes('60213afd') || receiver.includes('0055fd'))) {
    config.testTarget = config.testTarget || {};
    config.testTarget.buyerNick = PROTOCOL_TEST_BUYER;
    config.testTarget.appCid = appCid;
    config.testTarget.receiverAppUids = row.receiverAppUids;
  }
}

class ShopAutoReplier {
  constructor(shopTitle, options = {}) {
    this.shopTitle = shopTitle;
    this.httpPollMs = options.httpPollMs || 30000;
    this.svc = null;
    this.replied = new Set();
    this.discovered = new Map();
    this._pollTimer = null;
    this._replying = false;
    this.startedAt = Date.now();
  }

  async init() {
    const config = await buildShopConfig(this.shopTitle);
    this.config = config;
    this.svc = new QianfanProtocolService(this.shopTitle, { noCache: true });
    this.svc.config = config;
    this.svc.client = new (require('../src/protocol/qianfan-protocol-client').QianfanProtocolClient)(config);
    if (config.lastSeq) this.svc.client.setLastSeq(config.lastSeq);
    if (config.httpAuthHeaders) this.svc.client.setHttpAuthHeaders(config.httpAuthHeaders);
    const started = await this.svc.startListen({
      onBuyerMessage: (msg) => this.onBuyerMessage(msg, 'WS'),
    });
    console.log(
      `[triple-reply] ${this.shopTitle} listen ok=${started.ok} ws=${started.wsUrl || '-'} appCid=${config.testTarget?.appCid || '(待发现)'}`
    );
    if (this.httpPollMs > 0) this.startHttpPoll();
    return started;
  }

  shouldHandle(msg) {
    if (!msg || !isWsBuyerCandidate(msg)) return false;
    const reasonRef = { value: '' };
    if (isIgnoredMessage(msg, reasonRef)) return false;
    if (!isProtocolImSendAllowed(msg.buyerNick)) return false;
    return true;
  }

  async onBuyerMessage(msg, source) {
    if (!this.shouldHandle(msg)) return;
    rememberFanfanSession(this.config, this.discovered, msg);

    const msgId = String(msg.msgId || '').trim();
    const dedupKey = `${this.shopTitle}:${msgId || `${msg.appCid}:${msg.createAt}:${msg.text}`}`;

    if (source === 'HTTP') {
      const ts = normalizeCreateAtMs(msg.createAt) || 0;
      if (ts && ts < this.startedAt - 3000) {
        this.replied.add(dedupKey);
        return;
      }
    }

    if (this.replied.has(dedupKey)) return;
    this.replied.add(dedupKey);

    const text = String(msg.text || '').replace(/\s+/g, ' ').trim();
    console.log(
      `[triple-reply][${source}] shop=${this.shopTitle} buyer=${msg.buyerNick || '-'} text=${text.slice(0, 120)} msgId=${msgId || '-'}`
    );

    await this.replyToFanfan(msg);
  }

  async replyToFanfan(msg) {
    if (this._replying) return;
    this._replying = true;
    try {
      const appCid = String(msg.appCid || this.config?.testTarget?.appCid || '').trim();
      const receiverAppUids =
        (msg.senderAppUid && String(msg.senderAppUid).includes('60213afd')
          ? [msg.senderAppUid]
          : null) ||
        this.config?.testTarget?.receiverAppUids ||
        [FANFAN_RECEIVER];
      if (!appCid || !receiverAppUids.length) {
        console.log(`[triple-reply][reply-skip] ${this.shopTitle} 缺少 appCid/receiver`);
        return;
      }

      await primeClientSendFromListen(this.svc.client);
      await this.svc.client.openWsForSend();
      const result = await this.svc.client.sendText({
        appCid,
        receiverAppUids,
        text: REPLY_TEXT,
        reallySend: true,
        verifyList: false,
        buyerNick: msg.buyerNick || PROTOCOL_TEST_BUYER,
      });
      console.log(
        `[triple-reply][reply] ${this.shopTitle} ok=${result.ok} ack=${result.ack?.msgId || '-'} err=${result.error || result.reason || ''}`
      );
    } catch (err) {
      console.error(`[triple-reply][reply-fail] ${this.shopTitle}: ${err.message || err}`);
    } finally {
      this._replying = false;
    }
  }

  startHttpPoll() {
    const tick = async () => {
      const appCids = pickWatchAppCids(this.config, this.discovered);
      if (!appCids.length || !this.svc?.client) return;
      for (const appCid of appCids) {
        try {
          const page = await this.svc.client.fetchMessageList(appCid, {
            cursor: -1,
            count: 10,
            limit: 10,
          });
          if (!page.ok) {
            console.log(
              `[triple-reply][HTTP] ${this.shopTitle} poll failed appCid=${appCid.slice(0, 40)}... err=${page.error || page.apiMsg || 'unknown'}`
            );
            continue;
          }
          for (const row of page.messages || []) {
            if (row.isSellerSide) continue;
            await this.onBuyerMessage({ ...row, appCid: row.appCid || appCid, shopTitle: this.shopTitle }, 'HTTP');
          }
        } catch (err) {
          console.log(`[triple-reply][HTTP] ${this.shopTitle} error: ${err.message || err}`);
        }
      }
    };
    this._pollTimer = setInterval(() => void tick(), this.httpPollMs);
    setTimeout(() => void tick(), 4000);
  }

  stop() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this.svc) this.svc.stopListen();
  }
}

async function maybeWriteLocal(shops) {
  let existing = readExistingLocalConfig();
  disableFixtureShops(existing);
  for (const shopTitle of shops) {
    const config = await buildShopConfig(shopTitle);
    const merged = mergeShopIntoLocal(existing, config, shopTitle, true);
    existing = merged.shops;
  }
  saveLocalProtocolConfig(existing);
  console.log(`[triple-reply] 已写入 config/qianfan-protocol-shops.local.json (${shops.length} 店)`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法: node scripts/run-qianfan-protocol-triple-auto-reply.js [options]');
    console.log('  --shops 祥钰珠宝,和田雅玉,XY祥钰珠宝');
    console.log('  --http-poll-ms 30000');
    console.log('  --write-local  启动前合并 tap 配置到 local.json');
    process.exit(0);
  }

  console.log(`[triple-reply] 店铺: ${args.shops.join('、')} 回复文案: ${REPLY_TEXT}`);
  if (args.writeLocal) await maybeWriteLocal(args.shops);

  const workers = [];
  for (const shopTitle of args.shops) {
    const worker = new ShopAutoReplier(shopTitle, { httpPollMs: args.httpPollMs });
    await worker.init();
    workers.push(worker);
  }

  console.log('[triple-reply] 三店监听已启动，饭饭发新消息将自动回复「亲亲」（Ctrl+C 退出）');

  const shutdown = () => {
    console.log('\n[triple-reply] 正在退出...');
    for (const w of workers) w.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[triple-reply] FAILED', err.stack || err.message || err);
  process.exit(1);
});
