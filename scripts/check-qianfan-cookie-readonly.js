const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fullSrc = fs.readFileSync(path.join(__dirname, '../src/qianfan-full-cookie-collect.js'), 'utf8');
const uploaderSrc = fs.readFileSync(path.join(__dirname, '../src/shop-cookie-uploader.js'), 'utf8');

assert(fullSrc.includes('const readOnly = options.readOnly !== false'), 'collectFullCookiesFromBridge must default readOnly=true');
assert(fullSrc.includes('allowPageMutation'), 'collectFullCookiesFromBridge must use allowPageMutation guard');
assert(
  fullSrc.includes('readOnly=true，跳过页面刷新'),
  'missing a1 must log readOnly skip instead of reload by default'
);
assert(
  fullSrc.includes('readOnly=true，缺 access-token-ark 时不跳转 ark 页面'),
  'probeArkTokenViaPage must not navigate by default'
);

assert(
  /if\s*\(\s*allowPageMutation[\s\S]{0,200}client\.Page\?\.reload/.test(fullSrc),
  'Page.reload must be guarded by allowPageMutation'
);

const navigateIdx = fullSrc.indexOf('await client.Page.navigate({ url: arkUrl })');
assert(navigateIdx > 0, 'Page.navigate should exist only behind allowPageMutation');
const navigateContext = fullSrc.slice(Math.max(0, navigateIdx - 500), navigateIdx + 100);
assert(navigateContext.includes('allowPageMutation'), 'Page.navigate must be guarded by allowPageMutation');

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
