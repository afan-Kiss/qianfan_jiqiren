const assert = require('assert');
const fs = require('fs');
const path = require('path');

const uploader = require('../src/shop-cookie-uploader');
const full = require('../src/qianfan-full-cookie-collect');
const uploaderSrc = fs.readFileSync(path.join(__dirname, '../src/shop-cookie-uploader.js'), 'utf8');
const fullSrc = fs.readFileSync(path.join(__dirname, '../src/qianfan-full-cookie-collect.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(__dirname, '../src/qianfan-local-api.js'), 'utf8');

assert.strictEqual(typeof uploader.runShopCookieUploadAll, 'function');
assert.strictEqual(typeof full.collectFullCookiesFromBridge, 'function');
assert.strictEqual(typeof full.cookieContainsA1, 'function');
assert.strictEqual(typeof full.cookieContainsArkToken, 'function');

assert.strictEqual(full.cookieContainsA1('a1=abc; web_session=1'), true);
assert.strictEqual(full.cookieContainsA1('web_session=1; gid=2'), false);
assert.strictEqual(full.cookieContainsArkToken('access-token-ark.xiaohongshu.com=AT-abc; a1=1'), true);
assert.strictEqual(full.cookieContainsArkToken('a1=1; access-token-walle.xiaohongshu.com=x'), false);
assert.strictEqual(full.cookieContainsWalleToken('access-token-walle.xiaohongshu.com=abc'), true);

const merged = full.mergeCdpCookieEntries([
  { name: 'a1', value: 'short', domain: '.xiaohongshu.com' },
  { name: 'a1', value: 'longer-value-from-cdp', domain: '.xiaohongshu.com' },
  { name: 'access-token-ark.xiaohongshu.com', value: 'AT-xyz', domain: '.xiaohongshu.com' },
  { name: 'web_session', value: 'abc123', domain: 'walle.xiaohongshu.com' },
]);
assert(full.cookieContainsA1(merged.cookie), 'mergeCdpCookieEntries must keep a1');
assert(full.cookieContainsArkToken(merged.cookie), 'mergeCdpCookieEntries must keep ark token');
assert(merged.cookie.includes('longer-value-from-cdp'), 'merge must prefer longer a1 value');

const longest = full.mergeCookiePartsPreferLongest(
  'a1=from-header; gid=1',
  'a1=from-cdp-longer-value; web_session=xyz'
);
assert(longest.includes('a1=from-cdp-longer-value'), 'longest merge must keep longer a1');

assert(!uploaderSrc.includes('missing SHOP_COOKIE_UPLOAD_TOKEN'));
assert(!uploaderSrc.includes('未配置 SHOP_COOKIE_UPLOAD_TOKEN'));
assert(!uploaderSrc.includes('test_a=1'));
assert(fullSrc.includes('getAllCookies'));
assert(fullSrc.includes('Storage.getCookies'));
assert(fullSrc.includes('lastArkRequestCookie'));
assert(fullSrc.includes('probeArkTokenViaPage'));
assert(uploaderSrc.includes('缺少 a1，跳过上传'));
assert(uploaderSrc.includes('containsArkToken'));
assert(uploaderSrc.includes('[Cookie诊断]'));
assert(uploaderSrc.includes('shop.cookie typeof='));
assert(uploaderSrc.includes('skippedMissingArk'));
assert(uploaderSrc.includes('READ_ONLY_COOKIE_COLLECT_OPTIONS'));
assert(uploaderSrc.includes('readOnly: true'));
assert(uploaderSrc.includes('allowPageMutation: false'));
assert(apiSrc.includes('/api/shop-cookies/upload'));

const xy = uploader.matchPageToShop('XY祥钰珠宝-工作台');
assert.strictEqual(xy?.shopKey, 'xyxiangyu', 'XY page must match xyxiangyu not xiangyu');
const plain = uploader.matchPageToShop('祥钰珠宝-工作台');
assert.strictEqual(plain?.shopKey, 'xiangyu');
const plainShort = uploader.matchPageToShop('祥钰珠宝');
assert.strictEqual(plainShort?.shopKey, 'xiangyu', '祥钰珠宝 must not match xyxiangyu');

const cfg = uploader.getShopCookieUploadConfig();
assert.strictEqual(cfg.serverUrl, 'http://8.137.126.18');
assert.strictEqual(cfg.uploadPath, '/api/shop-cookies/update');
assert.strictEqual(cfg.statusPath, '/api/shop-cookies/status');

console.log('[check-shop-cookie-upload] dry-run passed (no fake cookie uploaded to production server)');
