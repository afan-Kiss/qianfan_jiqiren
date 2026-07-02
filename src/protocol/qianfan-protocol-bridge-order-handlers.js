/**
 * 千帆协议桥接 — 订单拉取 API（部署在服务器，供本地采集页调用）
 */
const { loadProtocolShopConfigs } = require('./qianfan-protocol-config');
const { collectOrdersQuery, EXPORT_COLUMNS } = require('./qianfan-protocol-order');

function listOrderShops() {
  try {
    const { shops } = loadProtocolShopConfigs({ allowEmpty: true });
    return shops.map((s) => ({
      shopTitle: s.shopTitle,
      sellerId: s.sellerId || s.orderApiFlow?.sellerId || '',
      hasOrderApi: Boolean(s.httpTemplates?.orderSearchList || s.orderApiSamples?.orderSearchList),
      cookieOk: Boolean(s.cookieSummary?.hasWalleToken || s.cookieSummary?.hasA1),
    }));
  } catch {
    return [];
  }
}

async function handleBridgeOrderShops() {
  return { ok: true, shops: listOrderShops() };
}

async function handleBridgeOrdersQuery(body = {}) {
  const result = await collectOrdersQuery({
    shopTitles: body.shopTitles,
    dateBegin: body.dateBegin,
    dateEnd: body.dateEnd,
    status: body.status,
    searchType: body.searchType,
    searchText: body.searchText,
    autoDecrypt: body.autoDecrypt !== false,
    fetchDetail: body.fetchDetail !== false,
    maxOrders: Number(body.maxOrders) || 0,
    concurrency: Number(body.concurrency) || 3,
  });
  return result;
}

function handleBridgeExportColumns() {
  return { ok: true, columns: EXPORT_COLUMNS };
}

module.exports = {
  handleBridgeOrderShops,
  handleBridgeOrdersQuery,
  handleBridgeExportColumns,
};
