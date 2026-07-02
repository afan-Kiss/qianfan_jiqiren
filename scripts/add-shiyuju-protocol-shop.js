#!/usr/bin/env node
/**
 * 补全第四店「拾玉居和田玉」纯协议配置（从祥钰模板 + 拾玉居抓包 flow 生成）
 */
const fs = require('fs');
const path = require('path');
const { localConfigPath, readJsonFile } = require('../src/protocol/qianfan-protocol-config');
const { saveLocalProtocolConfig } = require('../src/protocol/qianfan-live-context-extractor');
const { resolveProjectRoot } = require('../src/shared/app-root');

const SHOP_TITLE = '拾玉居和田玉';
const TEMPLATES = path.join(resolveProjectRoot(), 'dist', 'win-unpacked', 'data', 'xiangyu-captured-templates.json');

function pickFlowForShop(flow, shopTitle) {
  if (!Array.isArray(flow)) return [];
  const hits = flow.filter((s) => String(s?.shopTitle || '').trim() === shopTitle);
  return hits.length ? hits : flow.filter((s) => String(s?.shopTitle || '').trim() === shopTitle);
}

function pickPermitUrl(flow) {
  const step = [...flow]
    .reverse()
    .find((s) => s?.method === 'GET' && String(s.url || '').includes('/api/eva/upload/permit'));
  return step?.url || '';
}

function main() {
  const shops = readJsonFile(localConfigPath());
  if (shops.some((s) => String(s?.shopTitle || '').trim() === SHOP_TITLE)) {
    console.log(`[add-shiyuju] 已存在 ${SHOP_TITLE}，跳过`);
    return;
  }

  const baseIdx = shops.findIndex((s) => s?.shopTitle === '祥钰珠宝');
  if (baseIdx < 0) throw new Error('local 配置中未找到祥钰珠宝，无法克隆');
  const base = JSON.parse(JSON.stringify(shops[baseIdx]));
  base.shopTitle = SHOP_TITLE;
  base.enabled = true;
  delete base.testTarget?.appCid;
  delete base.testTarget?.receiverAppUids;

  const flowFromBase = pickFlowForShop(base.httpTemplates?.imageUploadFlow, SHOP_TITLE);
  let flow = flowFromBase;
  if (fs.existsSync(TEMPLATES)) {
    const tpl = JSON.parse(fs.readFileSync(TEMPLATES, 'utf8'));
    const fromTpl = pickFlowForShop(tpl.imageUploadFlow, SHOP_TITLE);
    if (fromTpl.length) flow = fromTpl;
  }

  base.httpTemplates = base.httpTemplates || {};
  if (flow.length) {
    base.httpTemplates.imageUploadFlow = flow;
    const permitUrl = pickPermitUrl(flow);
    if (permitUrl) {
      base.httpTemplates.imageUpload = {
        url: permitUrl,
        method: 'GET',
        headers: flow.find((s) => String(s.url || '').includes('/api/eva/upload/permit'))?.headers || {},
        note: 'EVA permit; 拾玉居 imageUploadFlow',
      };
    }
  }

  if (base.manualSamples?.imageSendPayload?.body) {
    delete base.manualSamples.imageSendPayload.body.appCid;
    delete base.manualSamples.imageSendPayload.body.receiverAppUids;
  }
  if (base.manualSamples?.textSendPayload?.body) {
    delete base.manualSamples.textSendPayload.body.appCid;
    delete base.manualSamples.textSendPayload.body.receiverAppUids;
  }

  shops.push(base);
  saveLocalProtocolConfig(shops);
  console.log(`[add-shiyuju] 已添加 ${SHOP_TITLE}（imageUploadFlow ${flow.length} 步）`);
}

main();
