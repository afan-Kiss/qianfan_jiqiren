#!/usr/bin/env node
const { findProtocolShopConfig } = require('../src/protocol/qianfan-protocol-config');
const { QianfanProtocolClient } = require('../src/protocol/qianfan-protocol-client');
const { writeProtocolReport, printProtocolSummary } = require('../src/protocol/qianfan-protocol-report');
const { parseProtocolArgs, printProtocolHelp } = require('./_protocol-cli');

function assertReallySendAllowed(shop, args) {
  const buyerNick = String(shop.testTarget?.buyerNick || '').trim();
  const appCid = String(shop.testTarget?.appCid || '').trim();
  const receiverAppUids = Array.isArray(shop.testTarget?.receiverAppUids)
    ? shop.testTarget.receiverAppUids.filter(Boolean)
    : [];
  const text = String(shop.testTarget?.text || '').trim();
  const wsUrl = String(shop?.ws?.url || '').trim();

  const errors = [];
  if (!wsUrl) errors.push('缺少 ws.url');
  if (!appCid) errors.push('缺少 testTarget.appCid');
  if (!receiverAppUids.length) errors.push('缺少 testTarget.receiverAppUids');
  if (!text) errors.push('缺少 testTarget.text');
  if (!buyerNick) errors.push('缺少 testTarget.buyerNick');
  if (buyerNick && buyerNick !== '饭饭' && !args.force) {
    errors.push(`真实发送仅允许测试买家「饭饭」，当前为「${buyerNick}」`);
  }
  return errors;
}

async function main() {
  const args = parseProtocolArgs(process.argv);
  if (args.help || !args.shop) {
    printProtocolHelp('test-qianfan-protocol-send-text.js', [
      '--shop "店铺名称"',
      '--really-send   真实发送（默认 dry-run）',
    ]);
    process.exit(args.help ? 0 : 1);
  }

  const shop = findProtocolShopConfig(args.shop);
  const client = new QianfanProtocolClient(shop);
  const appCid = String(shop.testTarget?.appCid || '').trim();
  const receiverAppUids = Array.isArray(shop.testTarget?.receiverAppUids)
    ? shop.testTarget.receiverAppUids.filter(Boolean)
    : [];
  const text = String(shop.testTarget?.text || '纯协议文字测试').trim();

  console.log(`[protocol:send-text] shop=${shop.shopTitle} reallySend=${args.reallySend}`);

  const dryRun = await client.sendText({
    appCid,
    receiverAppUids,
    text,
    reallySend: false,
  });
  console.log('[protocol:send-text] dry-run summary:', JSON.stringify(dryRun.payloadSummary, null, 2));

  let reallySend = { skipped: true, reason: 'not requested' };
  if (args.reallySend) {
    const gateErrors = assertReallySendAllowed(shop, args);
    if (gateErrors.length) {
      console.error('[protocol:send-text] 真实发送校验失败:');
      for (const e of gateErrors) console.error('  -', e);
      reallySend = { skipped: true, ok: false, errors: gateErrors };
    } else {
      await client.openWsForSend();
      reallySend = await client.sendText({
        appCid,
        receiverAppUids,
        text,
        reallySend: true,
      });
      client.closeWs();
      console.log('[protocol:send-text] really-send result:', {
        ok: reallySend.ok,
        msgId: reallySend.ack?.msgId,
        traceId: reallySend.traceId,
        error: reallySend.error,
      });
    }
  }

  const report = writeProtocolReport({
    testName: 'send-text',
    shopTitle: shop.shopTitle,
    shopProbe: require('../src/protocol/qianfan-protocol-config').probeShopConfig(shop),
    textSend: {
      dryRun,
      reallySend,
    },
  });
  printProtocolSummary(report);
}

main().catch((err) => {
  console.error('[protocol:send-text] FAILED', err.message || err);
  process.exit(1);
});
