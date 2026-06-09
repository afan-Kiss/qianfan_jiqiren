#!/usr/bin/env node
/**
 * 测试：机器人发送 + 原生 PC 同步链（不操作 Windows）
 * 用法：
 *   node scripts/test-native-sync-send.js --shop "XY祥钰珠宝" --text "原生同步测试"
 */
const CDP = require('chrome-remote-interface');
const { fetchDevToolsJsonList, getPageTargets } = require('../src/devtools-list');
const { detectQianfanShopPages } = require('../src/page-finder');
const { registerQianfanWsBridge, sendQianfanTextReply } = require('../src/qianfan-ws-bridge');

function parseArgs(argv) {
  const args = { shop: 'XY祥钰珠宝', text: '原生同步链路测试', appCid: '', receiver: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shop' && argv[i + 1]) args.shop = argv[++i];
    else if (a === '--text' && argv[i + 1]) args.text = argv[++i];
    else if (a === '--appCid' && argv[i + 1]) args.appCid = argv[++i];
    else if (a === '--receiver' && argv[i + 1]) args.receiver = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const list = await fetchDevToolsJsonList();
  const pages = getPageTargets(list);
  const report = detectQianfanShopPages(pages);
  const shop = report.shops.find((s) => String(s.shopTitle).includes(args.shop));
  if (!shop) throw new Error(`未找到店铺: ${args.shop}`);

  const client = await CDP({ target: shop.webSocketDebuggerUrl });
  const { cdpNetworkEnable } = require('../src/cdp-timeout');
  await cdpNetworkEnable(client.Network);
  await registerQianfanWsBridge(shop, client);
  await new Promise((r) => setTimeout(r, 3000));

  const appCid =
    args.appCid ||
    '$3$MSMyIzIjNjAyMTNhZmQwMDAwMDAwMDAxMDA1NWZk.MSMzIzYjNmEwMThmYTUzMGM5Y2YwMDE1MTIwMjJh';
  const receiverAppUids = args.receiver ? [args.receiver] : ['1#2#2#60213afd00000000010055fd'];

  console.log(`发送测试：店铺=${shop.shopTitle} appCid=${appCid}`);
  const ack = await sendQianfanTextReply({
    shopTitle: shop.shopTitle,
    appCid,
    receiverAppUids,
    text: args.text,
    buyerNick: '测试买家',
  });

  console.log('发送结果:', JSON.stringify(ack, null, 2));
  await client.close();
}

main().catch((err) => {
  console.error('[test-native-sync-send] 失败:', err.message || err);
  process.exit(1);
});
