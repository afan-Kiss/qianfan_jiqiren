const { collectAllShopCookies, cookieContainsA1 } = require('../src/shop-cookie-uploader');

(async () => {
  const c = await collectAllShopCookies();
  const keys = Object.keys(c.collectedByKey || {});
  console.log('SUMMARY shops=' + keys.length + ' missing=' + JSON.stringify(c.missing) + ' incomplete=' + JSON.stringify(c.incomplete));
  for (const k of keys) {
    const col = c.collectedByKey[k];
    const hasA1 = col.hasA1 || cookieContainsA1(col.cookie);
    const wouldUpload = hasA1 && typeof col.cookie === 'string' && col.cookie.trim() !== '[object Object]';
    console.log(
      JSON.stringify({
        shop: k,
        shopName: col.shopName,
        url: col.lastSeenUrl || '',
        targetId: col.targetId || '',
        browserContextId: col.browserContextId || '',
        cookieCount: col.cookieKeyCount,
        containsA1: hasA1,
        payloadContainsA1: hasA1,
        cookieType: typeof col.cookie,
        wouldUpload,
      })
    );
  }
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
