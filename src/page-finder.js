/**
 * 识别千帆店铺工作台页面
 */
const QIANFAN_PAGE_HINTS = [
  'edith.xiaohongshu.com',
  'xiaohongshu.com',
  '千帆',
  '客服',
  '工作台',
  '店铺',
];

function isWorkbenchPage(target) {
  const title = String(target.title || '');
  const url = String(target.url || '');
  return title.includes('工作台') && url.includes('walle.xiaohongshu.com/cstools/seller/dashboard');
}

function isQianfanRelatedPage(target) {
  const title = String(target.title || '');
  const url = String(target.url || '');
  if (isWorkbenchPage(target)) return true;
  const haystack = `${title} ${url}`.toLowerCase();
  return QIANFAN_PAGE_HINTS.some((hint) => {
    const h = hint.toLowerCase();
    return haystack.includes(h) || title.includes(hint);
  });
}

function extractShopTitle(target) {
  const pageTitle = String(target.title || '').trim();

  if (pageTitle.includes('工作台')) {
    const fromTitle = pageTitle.replace(/-工作台\s*$/, '').replace(/工作台\s*$/, '').trim();
    if (fromTitle) return fromTitle;
  }

  try {
    const u = new URL(target.url || '');
    for (const key of ['shopName', 'shop', 'sellerName', 'storeName']) {
      const value = u.searchParams.get(key);
      if (value) return decodeURIComponent(value).trim();
    }
    const pathMatch = u.pathname.match(/\/seller\/([^/?#]+)/i);
    if (pathMatch && pathMatch[1] && pathMatch[1] !== 'dashboard') {
      return decodeURIComponent(pathMatch[1]).trim();
    }
  } catch {
    // ignore invalid url
  }

  if (pageTitle) return `未识别店铺名（页面标题：${pageTitle}）`;
  return '未识别店铺名（页面标题：无标题）';
}

function findWorkbenchTargets(targets) {
  return (Array.isArray(targets) ? targets : []).filter(isWorkbenchPage);
}

function findQianfanRelatedTargets(targets) {
  return (Array.isArray(targets) ? targets : []).filter(isQianfanRelatedPage);
}

function toPageInfos(targets) {
  return targets.map((t, index) => ({
    index,
    title: t.title || '',
    shopTitle: extractShopTitle(t),
    pageTitle: String(t.title || ''),
    url: t.url || '',
    webSocketDebuggerUrl: t.webSocketDebuggerUrl,
  }));
}

/**
 * @param {Array} devtoolsPages DevTools /json/list 中的 page 条目
 * @param {{ expectedShopCount?: number }} options
 */
function detectQianfanShopPages(devtoolsPages, options = {}) {
  const expectedShopCount = Number(options.expectedShopCount || 4);
  const pages = Array.isArray(devtoolsPages) ? devtoolsPages : [];
  const workbenchTargets = findWorkbenchTargets(pages);
  const shops = toPageInfos(workbenchTargets).map((shop, index) => ({
    ...shop,
    index,
  }));

  const detectedShopCount = shops.length;

  return {
    ok: detectedShopCount >= 1,
    fullMatch: detectedShopCount >= expectedShopCount,
    expectedShopCount,
    detectedShopCount,
    shops,
    relatedPageCount: findQianfanRelatedTargets(pages).length,
  };
}

function validateQianfanDevToolsProbe(probe = {}, options = {}) {
  if (!probe.ok) {
    return { valid: false, reason: probe.reason || 'probe_not_ok' };
  }
  const list = Array.isArray(probe.list) ? probe.list : [];
  const shopReport = detectQianfanShopPages(list, options);
  if (shopReport.detectedShopCount > 0 || shopReport.relatedPageCount > 0) {
    return { valid: true, shopReport };
  }
  return {
    valid: false,
    reason: 'not_qianfan',
    shopReport,
  };
}

module.exports = {
  QIANFAN_PAGE_HINTS,
  isWorkbenchPage,
  isQianfanRelatedPage,
  extractShopTitle,
  findWorkbenchTargets,
  findQianfanRelatedTargets,
  toPageInfos,
  detectQianfanShopPages,
  validateQianfanDevToolsProbe,
};
