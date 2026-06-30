const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fullSrc = fs.readFileSync(path.join(__dirname, '../src/qianfan-full-cookie-collect.js'), 'utf8');
const uploaderSrc = fs.readFileSync(path.join(__dirname, '../src/shop-cookie-uploader.js'), 'utf8');

assert(fullSrc.includes('const readOnly = options.readOnly !== false'), 'collectFullCookiesFromBridge must default readOnly=true');
assert(fullSrc.includes('requestWillBeSentExtraInfo'), 'must listen requestWillBeSentExtraInfo for header cookies');
assert(fullSrc.includes('responseReceivedExtraInfo'), 'must listen responseReceivedExtraInfo for set-cookie');
assert(fullSrc.includes('associatedCookies'), 'must parse associatedCookies from extraInfo');
assert(
  fullSrc.includes('不刷新/不跳转页面'),
  'readOnly collect must not reload or navigate pages'
);
assert(
  fullSrc.includes('请在该店千帆产生订单/ark 请求后再提交'),
  'missing ark must log readOnly guidance instead of navigating'
);

assert(!fullSrc.includes('Page.navigate'), 'must not navigate pages for cookie collection');
assert(!fullSrc.includes('Page.reload'), 'must not reload pages for cookie collection');
assert(!fullSrc.includes('document.cookie'), 'must not rely on document.cookie');

assert(uploaderSrc.includes('READ_ONLY_COOKIE_COLLECT_OPTIONS'), 'shop uploader must define read-only collect options');
assert(uploaderSrc.includes('readOnly: true'), 'collect must pass readOnly:true');
assert(uploaderSrc.includes('allowPageMutation: false'), 'collect must pass allowPageMutation:false');
assert(uploaderSrc.includes('retryReload: false'), 'collect must pass retryReload:false');
assert(uploaderSrc.includes('skippedMissingArk'), 'filterUploadableCookies must track skippedMissingArk');
assert(uploaderSrc.includes('cookieContainsArkToken(collected.cookie)'), 'filter must require ark token');
assert(uploaderSrc.includes("shop.ok = false"), 'missing ark server status must not mark ok=true');
assert(
  uploaderSrc.includes("shop.serverStatus = 'missing_ark'"),
  'applyStatusToShopResults must set missing_ark'
);
assert(uploaderSrc.includes('isLoginOrAuthUrl'), 'must skip login page collection');
assert(uploaderSrc.includes('buildUploadPayload 跳过'), 'buildUploadPayload must skip missing ark');

console.log('[check-qianfan-cookie-readonly] passed');
