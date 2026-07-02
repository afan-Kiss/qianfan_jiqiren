#!/usr/bin/env node
/**
 * 纯协议实时收消息（控制台打印，供联调）
 */
const { findProtocolShopConfig } = require('../src/protocol/qianfan-protocol-config');
const { applyTapToShopConfig } = require('../src/protocol/qianfan-protocol-tap-config');
const { QianfanProtocolClient } = require('../src/protocol/qianfan-protocol-client');
const { isIgnoredMessage, isWsBuyerCandidate } = require('../src/chat-parse');

function parseArgs(argv) {
  const out = { shop: '祥钰珠宝', httpPollMs: 30000 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--shop' || a === '-s') out.shop = String(argv[++i] || out.shop).trim();
    else if (a === '--http-poll-ms') out.httpPollMs = Number(argv[++i]) || out.httpPollMs;
  }
  return out;
}

function pickAppCid(shop) {
  return (
    String(shop.testTarget?.appCid || '').trim() ||
    String(shop.manualSamples?.textSendPayload?.body?.appCid || '').trim() ||
    String(shop.httpTemplates?.messageList?.body?.appCid || '').trim()
  );
}

function printBuyer(source, msg) {
  if (!msg || !isWsBuyerCandidate(msg)) return;
  const reasonRef = { value: '' };
  if (isIgnoredMessage(msg, reasonRef)) return;
  const text = String(msg.text || msg.content || '').replace(/\s+/g, ' ').trim();
  console.log(
    `[live-listen][${source}] shop=${msg.shopTitle || '-'} buyer=${msg.buyerNick || '-'} text=${text.slice(0, 200)} msgId=${msg.msgId || '-'}`
  );
}

async function main() {
  const args = parseArgs(process.argv);
  let shop = findProtocolShopConfig(args.shop);
  const applied = applyTapToShopConfig(shop, { shopTitle: shop.shopTitle });
  shop = applied.config;
  const appCid = pickAppCid(shop);

  const client = new QianfanProtocolClient(shop);
  console.log(`[live-listen] shop=${shop.shopTitle}`);
  console.log(`[live-listen] listenUrl=${client.wsListenUrl || client.wsUrl || '(none)'}`);
  console.log(`[live-listen] appCid=${appCid || '(none)'} httpPollMs=${args.httpPollMs}`);
  console.log('[live-listen] 等待买家消息...（Ctrl+C 退出）');

  const ready = await client.startListening({
    onBuyerMessage: (m) => printBuyer('WS', m),
  });
  console.log('[live-listen] ready', JSON.stringify(ready));

  if (args.httpPollMs > 0 && appCid) {
    setInterval(async () => {
      try {
        const page = await client.fetchMessageList(appCid, { cursor: -1, count: 10, limit: 10 });
        if (!page.ok) {
          console.log(`[live-listen][HTTP] poll failed: ${page.error || page.apiMsg || 'unknown'}`);
          return;
        }
        for (const msg of page.messages || []) {
          if (msg.isSellerSide) continue;
          printBuyer('HTTP', { ...msg, shopTitle: shop.shopTitle, appCid });
        }
      } catch (err) {
        console.log(`[live-listen][HTTP] poll error: ${err.message || err}`);
      }
    }, args.httpPollMs);
  }
}

main().catch((err) => {
  console.error('[live-listen] FAILED', err.message || err);
  process.exit(1);
});
