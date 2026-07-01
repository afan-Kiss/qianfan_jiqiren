#!/usr/bin/env node
const { findProtocolShopConfig } = require('../src/protocol/qianfan-protocol-config');
const { QianfanProtocolClient } = require('../src/protocol/qianfan-protocol-client');
const { writeProtocolReport, printProtocolSummary } = require('../src/protocol/qianfan-protocol-report');
const { parseProtocolArgs, printProtocolHelp } = require('./_protocol-cli');

async function main() {
  const args = parseProtocolArgs(process.argv);
  if (args.help || !args.shop) {
    printProtocolHelp('test-qianfan-protocol-message-list.js', [
      '--shop "店铺名称"',
      '--app-cid "会话appCid"',
    ]);
    process.exit(args.help ? 0 : 1);
  }

  const shop = findProtocolShopConfig(args.shop);
  const appCid = args.appCid || String(shop.testTarget?.appCid || '').trim();
  if (!appCid) {
    console.error('[protocol:list] 缺少 appCid，请用 --app-cid 或填入 testTarget.appCid');
    process.exit(1);
  }

  const client = new QianfanProtocolClient(shop);
  console.log(`[protocol:list] shop=${shop.shopTitle} appCid=${appCid}`);
  const messageList = await client.fetchMessageList(appCid);
  console.log('[protocol:list] status:', messageList.status, 'messages:', messageList.messageCount);
  console.log('[protocol:list] preview:', JSON.stringify(messageList.messagesPreview, null, 2));

  const report = writeProtocolReport({
    testName: 'message-list',
    shopTitle: shop.shopTitle,
    appCid,
    shopProbe: require('../src/protocol/qianfan-protocol-config').probeShopConfig(shop),
    messageList,
  });
  printProtocolSummary(report);
}

main().catch((err) => {
  console.error('[protocol:list] FAILED', err.message || err);
  process.exit(1);
});
