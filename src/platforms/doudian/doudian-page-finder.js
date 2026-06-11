const { getDoudianConfig } = require('../../shared/config');
const { println } = require('../../shared/logger');

const PRIORITY_SERVICE_URLS = [
  'im.jinritemai.com/pc_seller_desk_v2/main/workspace',
  'fxg.jinritemai.com',
  'pigeon.jinritemai.com',
];

function getMatchRules(options = {}) {
  const cfg = getDoudianConfig();
  return { ...cfg.pageMatchRules, ...(options.pageMatchRules || {}) };
}

function haystackOf(target) {
  const title = String(target.title || target.pageTitle || '');
  const url = String(target.url || '');
  return `${title} ${url}`.toLowerCase();
}

function isExcludedPlatformPage(target) {
  const hay = haystackOf(target);
  return /xiaohongshu|walle\.xiaohongshu|千帆|qianfan|wechat|微信/i.test(hay);
}

function isDoudianRelatedPage(target, options = {}) {
  if (isExcludedPlatformPage(target)) return false;
  const rules = getMatchRules(options);
  const hay = haystackOf(target);
  const urlIncludes = rules.urlIncludes || [];
  const titleIncludes = rules.titleIncludes || [];
  const urlHit = urlIncludes.some((h) => hay.includes(String(h).toLowerCase()));
  const titleHit =
    urlHit &&
    titleIncludes.some((h) => hay.includes(String(h).toLowerCase()) || String(target.title || '').includes(h));
  const titleOnlyDoudian = /抖店|抖音电商|jinritemai|doudian/i.test(hay);
  return urlHit || titleOnlyDoudian || (titleHit && urlHit);
}

function isPriorityServiceUrl(target) {
  const url = String(target.url || '').toLowerCase();
  return PRIORITY_SERVICE_URLS.some((u) => url.includes(String(u).toLowerCase()));
}

function isDoudianServicePage(target, options = {}) {
  if (isPriorityServiceUrl(target)) return true;
  if (!isDoudianRelatedPage(target, options)) return false;
  const rules = getMatchRules(options);
  const hay = haystackOf(target);
  const hints = rules.servicePageHints || [];
  const hintHit = hints.some((h) => hay.includes(String(h).toLowerCase()));
  const titleService = /客服|消息|会话|im|chat/i.test(String(target.title || ''));
  return hintHit || titleService;
}

function extractShopInfo(target) {
  const title = String(target.title || '').trim();
  let shopName = '';
  let shopId = '';

  const titleMatch = title.match(/^(.+?)[-–—]?(抖店|客服|工作台|消息)/);
  if (titleMatch?.[1]) shopName = titleMatch[1].trim();

  try {
    const u = new URL(target.url || '');
    for (const key of ['shopId', 'shop_id', 'storeId', 'sellerId']) {
      const v = u.searchParams.get(key);
      if (v) shopId = v;
    }
    const pathMatch = u.pathname.match(/shop[s]?\/(\d+)/i);
    if (pathMatch?.[1]) shopId = pathMatch[1];
  } catch {
    // ignore
  }

  return { shopName, shopId };
}

function toPageInfo(target, index = 0, devtoolsPort = 0) {
  const { shopName, shopId } = extractShopInfo(target);
  return {
    index,
    pageId: target.id || `page-${index}`,
    title: target.title || '',
    url: target.url || '',
    webSocketDebuggerUrl: target.webSocketDebuggerUrl || '',
    shopName,
    shopId,
    isDoudianRelated: isDoudianRelatedPage(target),
    isServicePage: isDoudianServicePage(target),
    devtoolsPort,
  };
}

function findDoudianPages(devtoolsPages, options = {}) {
  const pages = Array.isArray(devtoolsPages) ? devtoolsPages : [];
  const port = Number(options.devtoolsPort || 0);
  const related = pages.filter((p) => isDoudianRelatedPage(p, options));
  const service = pages.filter((p) => isDoudianServicePage(p, options));
  const priority = pages.filter((p) => isPriorityServiceUrl(p));

  const relatedInfos = related.map((p, i) => toPageInfo(p, i, port));
  const serviceInfos = service.map((p, i) => toPageInfo(p, i, port));
  const priorityInfos = priority.map((p, i) => ({
    ...toPageInfo(p, i, port),
    isPriority: true,
  }));

  if (priorityInfos.length) {
    println(`已发现页面：抖店优先客服页 ${priorityInfos.length} 个`);
    for (const p of priorityInfos) {
      println(`发现客服页 URL: ${p.url}`);
    }
  } else if (serviceInfos.length) {
    println(`已发现页面：抖店客服页 ${serviceInfos.length} 个，相关页 ${relatedInfos.length} 个`);
  } else if (relatedInfos.length) {
    println(`已发现页面：抖店相关页 ${relatedInfos.length} 个（未命中客服页特征）`);
  } else {
    println('未发现抖店相关页面');
  }

  return {
    ok: priorityInfos.length > 0 || serviceInfos.length > 0 || relatedInfos.length > 0,
    servicePageCount: serviceInfos.length,
    relatedPageCount: relatedInfos.length,
    priorityPageCount: priorityInfos.length,
    servicePages: serviceInfos,
    relatedPages: relatedInfos,
    priorityServicePages: priorityInfos,
    priorityServicePage: priorityInfos[0] || null,
    bestServicePage: priorityInfos[0] || serviceInfos[0] || relatedInfos[0] || null,
  };
}

function classifyPagePlatform(target) {
  const hay = haystackOf(target);
  if (/jinritemai|doudian|抖店/i.test(hay)) return 'doudian';
  if (/xiaohongshu|千帆/i.test(hay)) return 'qianfan/xhs';
  if (/wechat|微信/i.test(hay)) return 'wechat';
  return 'unknown';
}

module.exports = {
  PRIORITY_SERVICE_URLS,
  isPriorityServiceUrl,
  isDoudianRelatedPage,
  isDoudianServicePage,
  extractShopInfo,
  toPageInfo,
  findDoudianPages,
  classifyPagePlatform,
};
