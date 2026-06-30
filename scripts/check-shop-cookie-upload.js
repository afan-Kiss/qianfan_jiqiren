const assert = require('assert');
const fs = require('fs');
const path = require('path');

const uploader = require('../src/shop-cookie-uploader');
const uploaderSrc = fs.readFileSync(path.join(__dirname, '../src/shop-cookie-uploader.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(__dirname, '../src/qianfan-local-api.js'), 'utf8');
const listenerSrc = fs.readFileSync(path.join(__dirname, '../src/qianfan-message-listener.js'), 'utf8');
const ipcSrc = fs.readFileSync(path.join(__dirname, '../src/main/ipc-bridge.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');

assert.strictEqual(typeof uploader.runShopCookieUploadAll, 'function');
assert.strictEqual(typeof uploader.triggerShopCookieUploadOnBuyerMessage, 'function');
assert.strictEqual(typeof uploader.uploadShopCookiesBatch, 'function');
assert.strictEqual(uploader.SHOP_KEY_BY_NAME['拾玉居'], 'shiyuju');
assert.strictEqual(uploader.SHOP_KEY_BY_NAME['XY祥钰珠宝'], 'xyxiangyu');
assert(!uploaderSrc.includes('missing SHOP_COOKIE_UPLOAD_TOKEN'));
assert(!uploaderSrc.includes('未配置 SHOP_COOKIE_UPLOAD_TOKEN'));

assert(apiSrc.includes('/api/shop-cookies/upload'));
assert(listenerSrc.includes('triggerShopCookieUploadOnBuyerMessage'));
assert(ipcSrc.includes('app:upload-shop-cookies'));
assert(preloadSrc.includes('uploadShopCookies'));
assert(htmlSrc.includes('btn-upload-cookies'));

console.log('[check-shop-cookie-upload] passed');
