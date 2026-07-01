const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fullSrc = fs.readFileSync(path.join(__dirname, '../src/qianfan-full-cookie-collect.js'), 'utf8');
const uploaderSrc = fs.readFileSync(path.join(__dirname, '../src/shop-cookie-uploader.js'), 'utf8');
const collectorSrc = fs.readFileSync(path.join(__dirname, '../src/qianfan-cookie-collector.js'), 'utf8');

assert(fullSrc.includes('const readOnly = options.readOnly !== false'), 'collectFullCookiesFromBridge must default readOnly=true');
assert(fullSrc.includes('requestWillBeSentExtraInfo'), 'must listen requestWillBeSentExtraInfo for header cookies');
assert(fullSrc.includes('responseReceivedExtraInfo'), 'must listen responseReceivedExtraInfo for set-cookie');
assert(fullSrc.includes('associatedCookies'), 'must parse associatedCookies from extraInfo');
assert(fullSrc.includes('requireRecentNetworkHeader'), 'must support passive recent network header gate');
assert(
  fullSrc.includes('不刷新/不跳转页面') || fullSrc.includes('networkHeaderWaitMs: 0'),
  'passive collect must not actively wait/navigate by default in uploader path'
);

assert(!fullSrc.includes('Page.navigate'), 'must not navigate pages for cookie collection');
assert(!fullSrc.includes('Page.reload'), 'must not reload pages for cookie collection');
assert(!fullSrc.includes('document.cookie'), 'must not rely on document.cookie');

assert(uploaderSrc.includes('READ_ONLY_COOKIE_COLLECT_OPTIONS'), 'shop uploader must define read-only collect options');
assert(uploaderSrc.includes('readOnly: true'), 'collect must pass readOnly:true');
assert(uploaderSrc.includes('requireRecentNetworkHeader: true'), 'collect must require recent network header');
assert(uploaderSrc.includes('skippedMissingArk'), 'filterUploadableCookies must track skippedMissingArk');
assert(uploaderSrc.includes('cookieContainsArkToken(collected.cookie)'), 'filter must require ark token');
assert(uploaderSrc.includes('isLoginOrAuthUrl'), 'must skip login page collection');
assert(uploaderSrc.includes('no_uploadable_shops'), 'must not POST when no uploadable shops');

assert(collectorSrc.includes('COOKIE_UPLOAD_BLOCKED_REASONS'), 'collector must define blocked upload reasons');
assert(collectorSrc.includes('schedulePassiveShopCookieUpload'), 'collector must schedule passive upload on network cookie');

console.log('[check-qianfan-cookie-readonly] passed');
