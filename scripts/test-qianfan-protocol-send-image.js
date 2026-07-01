#!/usr/bin/env node
const { findProtocolShopConfig } = require('../src/protocol/qianfan-protocol-config');
const { QianfanProtocolClient } = require('../src/protocol/qianfan-protocol-client');
const {
  analyzeImageSendRequirements,
  uploadImageByTemplate,
  sendImage,
} = require('../src/protocol/qianfan-protocol-image');
const { writeProtocolReport, printProtocolSummary } = require('../src/protocol/qianfan-protocol-report');
const { parseProtocolArgs, printProtocolHelp } = require('./_protocol-cli');

async function main() {
  const args = parseProtocolArgs(process.argv);
  if (args.help || !args.shop) {
    printProtocolHelp('test-qianfan-protocol-send-image.js', [
      '--shop "店铺名称"            默认只分析',
      '--dry-upload                 上传 dry-run',
      '--really-upload              真实上传',
      '--really-send                真实发送（需配合 --really-upload 或已有 upload 响应样本）',
    ]);
    process.exit(args.help ? 0 : 1);
  }

  const shop = findProtocolShopConfig(args.shop);
  const client = new QianfanProtocolClient(shop);
  const imagePath = shop.testTarget?.imagePath;
  const appCid = String(shop.testTarget?.appCid || '').trim();
  const receiverAppUids = Array.isArray(shop.testTarget?.receiverAppUids)
    ? shop.testTarget.receiverAppUids.filter(Boolean)
    : [];

  const imageAnalyze = analyzeImageSendRequirements(shop, imagePath);
  console.log('[protocol:send-image] analyze:', JSON.stringify(imageAnalyze, null, 2));

  let uploadDry = null;
  if (args.dryUpload || args.reallyUpload) {
    uploadDry = await uploadImageByTemplate(shop, imagePath, {
      reallyUpload: args.reallyUpload,
    });
    console.log('[protocol:send-image] upload:', uploadDry.ok ? 'ok' : uploadDry.error || 'failed');
  }

  let imageSend = null;
  if (args.reallySend) {
    const buyerNick = String(shop.testTarget?.buyerNick || '').trim();
    if (buyerNick !== '饭饭') {
      console.error('[protocol:send-image] 真实发送仅允许测试买家「饭饭」');
      process.exit(1);
    }
    imageSend = await sendImage({
      client,
      shopConfig: shop,
      appCid,
      receiverAppUids,
      imagePath,
      reallySend: true,
      reallyUpload: args.reallyUpload,
    });
  } else {
    imageSend = await sendImage({
      client,
      shopConfig: shop,
      appCid,
      receiverAppUids,
      imagePath,
      reallySend: false,
      reallyUpload: false,
    });
  }

  const report = writeProtocolReport({
    testName: 'send-image',
    shopTitle: shop.shopTitle,
    shopProbe: require('../src/protocol/qianfan-protocol-config').probeShopConfig(shop),
    imageAnalyze,
    uploadDry,
    imageSend,
  });
  printProtocolSummary(report);
}

main().catch((err) => {
  console.error('[protocol:send-image] FAILED', err.message || err);
  process.exit(1);
});
