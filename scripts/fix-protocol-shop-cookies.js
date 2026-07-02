#!/usr/bin/env node
/**
 * 修正四店 Cookie / sellerId 串店问题（从 shop-cookie-upload-cache + tap 抓包推断）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveProjectRoot } = require('../src/shared/app-root');
const { readJsonFile, localConfigPath } = require('../src/protocol/qianfan-protocol-config');
const { saveLocalProtocolConfig } = require('../src/protocol/qianfan-live-context-extractor');

/** tap 抓包中 shopTitle → seller_id 的真实对应 */
const SELLER_BY_SHOP = {
  祥钰珠宝: '691c5763084ee90015198056',
  和田雅玉: '6a195ac98228a600152aa204',
  'XY祥钰珠宝': '6a018fa530c9cf001512022a',
  拾玉居和田玉: '6a1a80892300910015e858f8',
};

/** shop-cookie-upload-cache 键名 → 配置 shopTitle */
const CACHE_KEY_BY_SHOP = {
  祥钰珠宝: 'xiangyu',
  和田雅玉: 'hetianyayu',
  拾玉居和田玉: 'shiyuju',
};

function md5(s) {
  return crypto.createHash('md5').update(String(s || '')).digest('hex').slice(0, 8);
}

function loadCookieCache() {
  const paths = [
    path.join(resolveProjectRoot(), 'data', 'shop-cookie-upload-cache.json'),
    path.join(resolveProjectRoot(), 'dist', 'win-unpacked', 'data', 'shop-cookie-upload-cache.json'),
  ];
  const merged = {};
  const used = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    used.push(p);
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const [k, v] of Object.entries(data || {})) {
      if (!merged[k] || String(v?.cookie || '').length > String(merged[k]?.cookie || '').length) {
        merged[k] = v;
      }
    }
  }
  return { path: used.join(' + ') || '(none)', data: merged };
}

function patchOrderSearchTemplate(shop) {
  const sellerId = SELLER_BY_SHOP[shop.shopTitle];
  if (!sellerId) return;
  const tpl = shop.httpTemplates?.orderSearchList;
  if (!tpl) return;
  tpl.url = `https://eva.xiaohongshu.com/api/edith/package/search-list?seller_id=${sellerId}&package_id=&page={page}&limit={limit}`;
  tpl.query = { seller_id: sellerId, package_id: '', page: '{page}', limit: '{limit}' };
}

function main() {
  const cache = loadCookieCache();
  const shops = readJsonFile(localConfigPath());
  const before = shops.map((s) => ({
    shopTitle: s.shopTitle,
    sellerId: s.sellerId,
    cookieHash: md5(s.cookie),
  }));

  for (const shop of shops) {
    const title = shop.shopTitle;
    const sellerId = SELLER_BY_SHOP[title];
    if (sellerId) {
      shop.sellerId = sellerId;
      if (shop.orderApiFlow) shop.orderApiFlow.sellerId = sellerId;
    }

    const cacheKey = CACHE_KEY_BY_SHOP[title];
    const fromCache = cacheKey ? String(cache.data[cacheKey]?.cookie || '').trim() : '';
    if (fromCache.length > 100) {
      shop.cookie = fromCache;
      if (shop.ws?.headers) shop.ws.headers.Cookie = fromCache;
    }

    patchOrderSearchTemplate(shop);
  }

  saveLocalProtocolConfig(shops);

  const after = shops.map((s) => ({
    shopTitle: s.shopTitle,
    sellerId: s.sellerId,
    cookieHash: md5(s.cookie),
  }));

  console.log('[fix-shop-cookies] cache:', cache.path || '(none)');
  console.log('[fix-shop-cookies] before:', JSON.stringify(before, null, 2));
  console.log('[fix-shop-cookies] after: ', JSON.stringify(after, null, 2));

  const hashes = after.map((s) => s.cookieHash);
  const dup = hashes.filter((h, i) => hashes.indexOf(h) !== i);
  if (dup.length) {
    console.warn('[fix-shop-cookies] 警告: 仍有重复 cookie hash:', [...new Set(dup)].join(', '));
    process.exitCode = 1;
  } else {
    console.log('[fix-shop-cookies] 四店 cookie 已各不相同');
  }
}

main();
