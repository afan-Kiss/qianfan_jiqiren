#!/usr/bin/env node
/**
 * 将 xiangyu-captured-templates.json 中的图片/文字样本合并进 protocol local 配置
 */
const fs = require('fs');
const path = require('path');
const { localConfigPath, readJsonFile } = require('../src/protocol/qianfan-protocol-config');
const { saveLocalProtocolConfig } = require('../src/protocol/qianfan-live-context-extractor');
const { resolveProjectRoot } = require('../src/shared/app-root');

function parseArgs(argv) {
  const out = {
    shop: '祥钰珠宝',
    templates:
      process.env.XIANGYU_CAPTURED_TEMPLATES ||
      path.join(resolveProjectRoot(), 'dist', 'win-unpacked', 'data', 'xiangyu-captured-templates.json'),
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--shop') out.shop = String(argv[++i] || out.shop).trim();
    else if (a === '--templates') out.templates = String(argv[++i] || '').trim();
  }
  return out;
}

function pickImageUploadFlow(templates, shopTitle) {
  const flow = Array.isArray(templates?.imageUploadFlow) ? templates.imageUploadFlow : [];
  const forShop = flow.filter((s) => !s.shopTitle || s.shopTitle === shopTitle);
  return forShop.length ? forShop : flow;
}

function pickPermitStep(flow) {
  return [...flow]
    .reverse()
    .find((s) => s.method === 'GET' && String(s.url || '').includes('/api/eva/upload/permit'));
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法: node scripts/import-xiangyu-captured-to-protocol.js [--shop 祥钰珠宝] [--templates path]');
    process.exit(0);
  }

  if (!fs.existsSync(args.templates)) {
    console.error(`[import] 未找到抓包文件: ${args.templates}`);
    process.exit(1);
  }

  const templates = JSON.parse(fs.readFileSync(args.templates, 'utf8'));
  const configPath = localConfigPath();
  const shops = readJsonFile(configPath);
  const idx = shops.findIndex((s) => s?.shopTitle === args.shop);
  if (idx < 0) {
    console.error(`[import] local 配置中未找到店铺: ${args.shop}`);
    process.exit(1);
  }

  const shop = shops[idx];
  shop.manualSamples = shop.manualSamples || {};
  shop.httpTemplates = shop.httpTemplates || {};

  const imageSend = templates.imageSend;
  if (imageSend?.template) {
    const payload = JSON.parse(JSON.stringify(imageSend.template));
    if (imageSend.appCid) {
      payload.body = payload.body || {};
      payload.body.appCid = imageSend.appCid;
      payload.body.receiverAppUids = imageSend.receiverAppUids || payload.body.receiverAppUids;
    }
    shop.manualSamples.imageSendPayload = payload;
    console.log('[import] manualSamples.imageSendPayload ← imageSend.template');
  }

  const textSend = templates.textSend;
  if (textSend?.template) {
    const payload = JSON.parse(JSON.stringify(textSend.template));
    if (textSend.appCid) {
      payload.body = payload.body || {};
      payload.body.appCid = textSend.appCid;
      payload.body.receiverAppUids = textSend.receiverAppUids || payload.body.receiverAppUids;
    }
    shop.manualSamples.textSendPayload = payload;
    console.log('[import] manualSamples.textSendPayload ← textSend.template');
  }

  const flow = pickImageUploadFlow(templates, args.shop);
  if (flow.length) {
    shop.httpTemplates.imageUploadFlow = flow;
    const permit = pickPermitStep(flow);
    if (permit?.url) {
      shop.httpTemplates.imageUpload = {
        url: permit.url.split('?')[0] + '?biz_name=cs&scene=feeva_img&file_count=1&version=1&source=web',
        method: 'GET',
        headers: permit.headers || {},
        note: 'EVA permit; 实际上传走 qianfan-protocol-eva-upload',
      };
    }
    console.log(`[import] httpTemplates.imageUploadFlow (${flow.length} steps)`);
  }

  if (templates.imageUpload?.url) {
    shop.httpTemplates.imageUploadRos = templates.imageUpload;
    console.log('[import] httpTemplates.imageUploadRos 样本已保留');
  }

  shops[idx] = shop;
  saveLocalProtocolConfig(shops);
  console.log(`[import] 已写入 ${configPath}`);
}

main();
