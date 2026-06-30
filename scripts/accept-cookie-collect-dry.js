const {
  collectAllShopCookies,
  cookieContainsA1,
  cookieContainsArkToken,
  cookieContainsWalleToken,
} = require('../src/shop-cookie-uploader');

(async () => {
  const c = await collectAllShopCookies();
  const keys = Object.keys(c.collectedByKey || {});
  console.log('SUMMARY shops=' + keys.length + ' missing=' + JSON.stringify(c.missing) + ' incomplete=' + JSON.stringify(c.incomplete));
  console.log('| 店铺 | containsA1 | containsArkToken | containsWalleToken | cookieLength | wouldUpload |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const k of keys) {
    const col = c.collectedByKey[k];
    const hasA1 = col.hasA1 || cookieContainsA1(col.cookie);
    const hasArk = col.hasArk || cookieContainsArkToken(col.cookie);
    const hasWalle = col.hasWalle || cookieContainsWalleToken(col.cookie);
    const wouldUpload =
      hasA1 && typeof col.cookie === 'string' && col.cookie.trim() !== '[object Object]';
    console.log(
      `| ${col.shopName || k} | ${hasA1} | ${hasArk} | ${hasWalle} | ${col.cookie?.length || 0} | ${wouldUpload} |`
    );
    console.log(
      JSON.stringify({
        shop: k,
        shopName: col.shopName,
        url: col.lastSeenUrl || '',
        targetId: col.targetId || '',
        browserContextId: col.browserContextId || '',
        cookieCount: col.cookieKeyCount,
        containsA1: hasA1,
        containsArkToken: hasArk,
        containsWalleToken: hasWalle,
        payloadContainsArkToken: hasArk,
        cookieType: typeof col.cookie,
        wouldUpload,
      })
    );
  }
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
