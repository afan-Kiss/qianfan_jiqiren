#!/usr/bin/env node
const {
  loadProtocolShopConfigs,
  probeShopConfig,
  LOCAL_SETUP_HINT,
} = require('../src/protocol/qianfan-protocol-config');
const { writeProtocolReport, printProtocolSummary } = require('../src/protocol/qianfan-protocol-report');

async function main() {
  let shops = [];
  let warnings = [];
  try {
    const loaded = loadProtocolShopConfigs({ allowEmpty: true });
    shops = loaded.shops;
    warnings = loaded.warnings || [];
  } catch (err) {
    console.error('[qf:protocol:probe] 配置未就绪');
    console.error(err.message || err);
    if (err.hint) console.error(err.hint);
    process.exit(1);
  }

  console.log(`[qf:protocol:probe] enabled 店铺数: ${shops.length}`);
  if (warnings.length) {
    console.log('[qf:protocol:probe] 配置警告:');
    for (const w of warnings) console.log(`  - ${w.shopTitle}: ${w.errors.join(', ')}`);
  }

  const probes = shops.map(probeShopConfig);
  for (const p of probes) {
    console.log('\n---', p.shopTitle, '---');
    console.log('Cookie 长度:', p.cookieSummary.length);
    console.log('a1:', p.cookieSummary.hasA1, 'web_session:', p.cookieSummary.hasWebSession);
    console.log('access-token:', p.cookieSummary.hasAccessToken);
    console.log('ark:', p.cookieSummary.hasArkToken, 'walle:', p.cookieSummary.hasWalleToken);
    console.log('keysPreview:', p.cookieSummary.keysPreview.join(', ') || '(none)');
    console.log('ws.url:', p.hasWsUrl);
    console.log('messageList URL:', p.hasMessageListUrl);
    console.log('imageUpload URL:', p.hasImageUploadUrl);
    console.log('testTarget.appCid:', p.hasTestAppCid);
    console.log('receiverAppUids:', p.hasReceiverAppUids, `count=${p.receiverAppUidsCount}`);
    console.log('imageSendPayload 样本:', p.hasImageSendPayloadSample);
    console.log('testTarget.buyerNick:', p.testTargetBuyerNick || '-');
  }

  const report = writeProtocolReport({
    testName: 'probe',
    shopCount: shops.length,
    probes,
    warnings,
  });
  printProtocolSummary(report);
}

main().catch((err) => {
  console.error('[qf:protocol:probe] FAILED', err.message || err);
  process.exit(1);
});
