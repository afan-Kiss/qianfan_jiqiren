const assert = require('assert');
const {
  normalizeCookie,
  hashCookie,
  shouldUploadCookie,
  detectShopFromQianfanContext,
} = require('../src/qianfan-cookie-collector');

function testNormalize() {
  const a = normalizeCookie('b=2; a=1; a=1');
  assert.strictEqual(a, 'a=1; b=2');
}

function testHashStable() {
  const h1 = hashCookie('a=1; b=2');
  const h2 = hashCookie('b=2; a=1');
  assert.strictEqual(h1, h2);
  assert.strictEqual(h1.length, 64);
}

function testShouldUpload() {
  const collected = { shopName: '店A', shopId: '1', cookieHash: 'abc' };
  const first = shouldUploadCookie(null, collected);
  assert.strictEqual(first.upload, true);

  const same = shouldUploadCookie(
    { cookieHash: 'abc', lastUploadedAt: new Date().toISOString(), lastUploadStatus: 'ok' },
    collected
  );
  assert.strictEqual(same.upload, false);

  const changed = shouldUploadCookie(
    { cookieHash: 'old', lastUploadedAt: new Date().toISOString(), lastUploadStatus: 'ok' },
    collected
  );
  assert.strictEqual(changed.upload, true);

  const failed = shouldUploadCookie({ lastUploadStatus: 'failed', cookieHash: 'abc' }, collected);
  assert.strictEqual(failed.upload, true);
}

function testDetectShop() {
  const ctx = detectShopFromQianfanContext(
    { shopTitle: '测试店-工作台', url: 'https://walle.xiaohongshu.com/cstools/seller/dashboard' },
    {}
  );
  assert.ok(ctx.shopName.includes('测试店'));
}

testNormalize();
testHashStable();
testShouldUpload();
testDetectShop();
console.log('[check-qianfan-cookie-collector] passed');
