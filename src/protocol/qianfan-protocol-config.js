/**
 * 千帆纯协议测试 — 本地配置加载（旁路模块，不参与主链路）
 */
const fs = require('fs');
const path = require('path');
const { resolveProjectRoot } = require('../shared/app-root');

const EXAMPLE_FILE = 'qianfan-protocol-shops.example.json';
const LOCAL_FILE = 'qianfan-protocol-shops.local.json';

const LOCAL_SETUP_HINT =
  '请复制 config/qianfan-protocol-shops.example.json 为 config/qianfan-protocol-shops.local.json，并填入 Cookie、WS URL、appCid、receiverAppUids。';

function configDir() {
  return path.join(resolveProjectRoot(), 'config');
}

function localConfigPath() {
  return path.join(configDir(), LOCAL_FILE);
}

function exampleConfigPath() {
  return path.join(configDir(), EXAMPLE_FILE);
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error(`${path.basename(filePath)} 必须是 JSON 数组`);
  }
  return data;
}

function cookieContainsKey(cookie, pattern) {
  return pattern.test(String(cookie || ''));
}

function extractCookieKeys(cookie) {
  const keys = [];
  for (const seg of String(cookie || '').split(';')) {
    const piece = seg.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    keys.push(piece.slice(0, eq).trim());
  }
  return [...new Set(keys)];
}

function summarizeCookie(cookie) {
  const text = String(cookie || '').trim();
  const keys = extractCookieKeys(text);
  return {
    length: text.length,
    hasA1: cookieContainsKey(text, /(?:^|;\s*)a1=/i),
    hasWebSession: cookieContainsKey(text, /(?:^|;\s*)web_session=/i),
    hasAccessToken: cookieContainsKey(text, /(?:^|;\s*)access-token=/i),
    hasArkToken: cookieContainsKey(text, /(?:^|;\s*)access-token-ark/i),
    hasWalleToken: cookieContainsKey(text, /(?:^|;\s*)access-token-walle/i),
    keysPreview: keys.slice(0, 20),
    keyCount: keys.length,
  };
}

function validateShopConfig(shop, index = 0) {
  const errors = [];
  const label = shop?.shopTitle || `index=${index}`;
  if (!String(shop?.shopTitle || '').trim()) errors.push('缺少 shopTitle');
  if (!String(shop?.cookie || '').trim()) errors.push('缺少 cookie');
  return { label, errors };
}

function loadProtocolShopConfigs(options = {}) {
  const localPath = localConfigPath();
  if (!fs.existsSync(localPath)) {
    const err = new Error(LOCAL_SETUP_HINT);
    err.code = 'PROTOCOL_CONFIG_MISSING';
    err.hint = LOCAL_SETUP_HINT;
    err.examplePath = exampleConfigPath();
    throw err;
  }

  const all = readJsonFile(localPath);
  const enabled = all.filter((row) => row && row.enabled !== false);
  const shops = [];
  const warnings = [];

  for (let i = 0; i < enabled.length; i += 1) {
    const shop = enabled[i];
    const { label, errors } = validateShopConfig(shop, i);
    if (errors.length) {
      warnings.push({ shopTitle: label, errors });
      continue;
    }
    shops.push({
      ...shop,
      shopTitle: String(shop.shopTitle).trim(),
      cookie: String(shop.cookie).trim(),
      userAgent: String(shop.userAgent || '').trim(),
      origin: String(shop.origin || 'https://walle.xiaohongshu.com').trim(),
      referer: String(shop.referer || 'https://walle.xiaohongshu.com/').trim(),
      ws: shop.ws || {},
      httpTemplates: shop.httpTemplates || {},
      manualSamples: shop.manualSamples || {},
      testTarget: shop.testTarget || {},
      cookieSummary: summarizeCookie(shop.cookie),
    });
  }

  if (!shops.length && !options.allowEmpty) {
    const err = new Error('没有 enabled=true 且校验通过的店铺配置');
    err.code = 'PROTOCOL_CONFIG_EMPTY';
    err.warnings = warnings;
    throw err;
  }

  return { shops, warnings, localPath };
}

function findProtocolShopConfig(shopTitle, options = {}) {
  const title = String(shopTitle || '').trim();
  if (options.allowIncomplete) {
    const localPath = localConfigPath();
    if (fs.existsSync(localPath)) {
      const all = readJsonFile(localPath);
      const hit = all.find((s) => s && String(s.shopTitle || '').trim() === title);
      if (hit) {
        return {
          ...hit,
          shopTitle: title,
          cookie: String(hit.cookie || '').trim(),
          cookieSummary: summarizeCookie(hit.cookie),
        };
      }
    }
  }
  const { shops } = loadProtocolShopConfigs(options);
  const hit = shops.find((s) => s.shopTitle === title);
  if (!hit) {
    const available = shops.map((s) => s.shopTitle);
    const err = new Error(`未找到店铺配置「${title}」，可用：${available.join('、') || '(无)'}`);
    err.code = 'PROTOCOL_SHOP_NOT_FOUND';
    throw err;
  }
  return hit;
}

function probeShopConfig(shop) {
  const wsUrl = String(shop?.ws?.url || '').trim();
  const messageListUrl = String(shop?.httpTemplates?.messageList?.url || '').trim();
  const imageUploadUrl = String(shop?.httpTemplates?.imageUpload?.url || '').trim();
  const appCid = String(shop?.testTarget?.appCid || '').trim();
  const receiverAppUids = Array.isArray(shop?.testTarget?.receiverAppUids)
    ? shop.testTarget.receiverAppUids.filter(Boolean)
    : [];
  const imageSendPayload = shop?.manualSamples?.imageSendPayload;
  const hasImageSendSample =
    imageSendPayload && typeof imageSendPayload === 'object' && Object.keys(imageSendPayload).length > 0;

  return {
    shopTitle: shop.shopTitle,
    enabled: shop.enabled !== false,
    cookieSummary: shop.cookieSummary || summarizeCookie(shop.cookie),
    hasWsUrl: Boolean(wsUrl),
    hasMessageListUrl: Boolean(messageListUrl),
    hasImageUploadUrl: Boolean(imageUploadUrl),
    hasTestAppCid: Boolean(appCid),
    hasReceiverAppUids: receiverAppUids.length > 0,
    receiverAppUidsCount: receiverAppUids.length,
    hasImageSendPayloadSample: hasImageSendSample,
    testTargetBuyerNick: String(shop?.testTarget?.buyerNick || '').trim(),
    testTargetText: String(shop?.testTarget?.text || '').trim(),
    testTargetImagePath: String(shop?.testTarget?.imagePath || '').trim(),
  };
}

module.exports = {
  LOCAL_SETUP_HINT,
  localConfigPath,
  exampleConfigPath,
  summarizeCookie,
  loadProtocolShopConfigs,
  findProtocolShopConfig,
  probeShopConfig,
};
