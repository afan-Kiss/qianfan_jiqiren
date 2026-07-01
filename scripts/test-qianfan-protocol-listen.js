#!/usr/bin/env node
const { findProtocolShopConfig } = require('../src/protocol/qianfan-protocol-config');
const { QianfanProtocolClient } = require('../src/protocol/qianfan-protocol-client');
const { writeProtocolReport, printProtocolSummary } = require('../src/protocol/qianfan-protocol-report');
const { parseProtocolArgs, printProtocolHelp } = require('./_protocol-cli');

async function main() {
  const args = parseProtocolArgs(process.argv);
  if (args.help || !args.shop) {
    printProtocolHelp('test-qianfan-protocol-listen.js', [
      '--shop "店铺名称"',
      '--listen-ms 30000',
    ]);
    process.exit(args.help ? 0 : 1);
  }

  const shop = findProtocolShopConfig(args.shop);
  const client = new QianfanProtocolClient(shop);

  if (!client.wsUrl) {
    console.error('[protocol:listen] 缺少 ws.url，无法监听');
    process.exit(1);
  }

  console.log(`[protocol:listen] shop=${shop.shopTitle} listenMs=${args.listenMs}`);
  const listen = await client.connectWs({ listenMs: args.listenMs });
  console.log('[protocol:listen] actions:', JSON.stringify(listen.actions));
  console.log('[protocol:listen] buyerMessageCount:', listen.buyerMessageCount);

  const report = writeProtocolReport({
    testName: 'listen',
    shopTitle: shop.shopTitle,
    shopProbe: require('../src/protocol/qianfan-protocol-config').probeShopConfig(shop),
    listen,
    buyerMessagesPreview: client.buyerMessages.slice(0, 10).map((m) => ({
      buyerNick: m.buyerNick,
      text: String(m.text || '').slice(0, 120),
      appCid: m.appCid,
      msgId: m.msgId,
    })),
  });
  printProtocolSummary(report);
}

main().catch((err) => {
  console.error('[protocol:listen] FAILED', err.message || err);
  process.exit(1);
});
