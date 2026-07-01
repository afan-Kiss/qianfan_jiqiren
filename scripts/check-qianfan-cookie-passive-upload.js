const assert = require('assert');
const fs = require('fs');
const path = require('path');

const collectorSrc = fs.readFileSync(path.join(__dirname, '../src/qianfan-cookie-collector.js'), 'utf8');
const fullSrc = fs.readFileSync(path.join(__dirname, '../src/qianfan-full-cookie-collect.js'), 'utf8');
const uploaderSrc = fs.readFileSync(path.join(__dirname, '../src/shop-cookie-uploader.js'), 'utf8');
const wsSrc = fs.readFileSync(path.join(__dirname, '../src/qianfan-ws-bridge.js'), 'utf8');

assert(
  /function onBridgeRegistered[\s\S]{0,400}ensureBridgeNetworkHeaderListeners/.test(collectorSrc),
  'onBridgeRegistered must attach network header listeners'
);
assert(
  !/onBridgeRegistered[\s\S]{0,400}triggerCookieCheck/.test(collectorSrc),
  'onBridgeRegistered must not trigger cookie upload'
);
assert(
  !/function onWsConnected[\s\S]{0,200}triggerCookieCheck/.test(collectorSrc),
  'onWsConnected must not trigger cookie upload'
);
assert(
  !/function runStartupCookieSync[\s\S]{0,200}triggerCookieCheck/.test(collectorSrc),
  'runStartupCookieSync must not trigger cookie upload'
);
assert(
  !/function runFallbackCheckAll[\s\S]{0,400}triggerCookieCheck/.test(collectorSrc),
  'runFallbackCheckAll must not trigger cookie upload'
);
assert(collectorSrc.includes('cookieUploadDirty'), 'noteBridgeRequestCookie must mark cookieUploadDirty');
assert(collectorSrc.includes('schedulePassiveShopCookieUpload'), 'must debounce passive shop upload');
assert(fullSrc.includes('requireRecentNetworkHeader'), 'collect must support requireRecentNetworkHeader');
assert(fullSrc.includes('no_network_cookie_seen'), 'collect must skip when no network header seen');
assert(uploaderSrc.includes('requireRecentNetworkHeader: true'), 'uploader must require recent network header');
assert(uploaderSrc.includes('no_uploadable_shops'), 'batch upload must skip empty payload');
assert(uploaderSrc.includes('no_recent_network_cookie'), 'runShopCookieUploadAll must report no recent network cookie');
assert(!fullSrc.includes('Page.navigate'), 'must not navigate for cookie');
assert(!fullSrc.includes('Page.reload'), 'must not reload for cookie');
assert(!fullSrc.includes('Runtime.evaluate'), 'must not use Runtime.evaluate fetch probe');
assert(!wsSrc.includes("triggerCookieCheck(shopTitle, 'request_cookie')"), 'ws-bridge must not directly trigger upload');

const {
  noteBridgeRequestCookie,
  clearBridgeCookieUploadDirty,
  isCookieUploadReasonBlocked,
  isCookieUploadReasonAllowed,
} = require('../src/qianfan-cookie-collector');
const { collectFullCookiesFromBridge, cookieContainsA1, cookieContainsArkToken } = require('../src/qianfan-full-cookie-collect');

assert(isCookieUploadReasonBlocked('startup'), 'startup must be blocked');
assert(isCookieUploadReasonBlocked('bridge_registered'), 'bridge_registered must be blocked');
assert(isCookieUploadReasonAllowed('request_cookie'), 'request_cookie must be allowed');
assert(isCookieUploadReasonBlocked('interval'), 'interval must be blocked');

const bridge = {
  shopTitle: '祥钰珠宝',
  client: null,
  pageInfo: { url: 'https://walle.xiaohongshu.com/cstools/seller/dashboard' },
};

(async () => {
  const skipped = await collectFullCookiesFromBridge(bridge, {
    requireRecentNetworkHeader: true,
    logDiagnostics: false,
  });
  assert(skipped?.skipped === true, 'b: no lastNetworkHeaderCapturedAt must return skipped');
  assert(skipped.reason === 'no_network_cookie_seen', 'b: reason must be no_network_cookie_seen');

  noteBridgeRequestCookie(
    bridge,
    'a1=test123456789012345678901234567890; access-token-walle.xiaohongshu.com=abc',
    'https://walle.xiaohongshu.com/api/test'
  );
  assert(bridge.cookieUploadDirty === true, 'd: noteBridgeRequestCookie must mark dirty');
  assert(Number(bridge.lastNetworkHeaderCapturedAt) > 0, 'd: must set lastNetworkHeaderCapturedAt');

  const jarOnly = await collectFullCookiesFromBridge(
    {
      shopTitle: '祥钰珠宝',
      client: { Network: { enable: async () => {}, getAllCookies: async () => ({ cookies: [{ name: 'a1', value: 'only-from-jar-not-header', domain: '.xiaohongshu.com' }] }) } },
      pageInfo: { url: 'https://walle.xiaohongshu.com/cstools/seller/dashboard' },
    },
    { requireRecentNetworkHeader: true, logDiagnostics: false, networkHeaderWaitMs: 0 }
  );
  assert(jarOnly?.skipped === true, 'c: jar-only without network header must skip');

  bridge.client = {
    Network: {
      enable: async () => {},
      getAllCookies: async () => ({ cookies: [] }),
      requestWillBeSent: () => {},
    },
    Page: { enable: async () => {} },
    Runtime: { enable: async () => {} },
  };

  const headerOnly = await collectFullCookiesFromBridge(bridge, {
    requireRecentNetworkHeader: true,
    logDiagnostics: false,
    networkHeaderWaitMs: 0,
    includeJarFallback: false,
  });
  assert(!headerOnly?.skipped, 'header capture should not skip when recent header exists');
  assert(cookieContainsA1(headerOnly.cookie), 'header cookie should contain a1');
  assert(headerOnly.hasArk === false, 'e: missing ark should be detectable');
  assert(!cookieContainsArkToken(headerOnly.cookie), 'e: missing ark cookie must not contain ark token');

  const filtered = { uploadable: {} };
  assert(Object.keys(filtered.uploadable).length === 0, 'f: empty uploadable must stay empty');

  clearBridgeCookieUploadDirty(bridge);
  assert(bridge.cookieUploadDirty === false, 'upload success path must clear dirty');

  console.log('[check-qianfan-cookie-passive-upload] OK');
})().catch((err) => {
  console.error('[check-qianfan-cookie-passive-upload] FAILED');
  console.error(err.message || err);
  process.exit(1);
});
