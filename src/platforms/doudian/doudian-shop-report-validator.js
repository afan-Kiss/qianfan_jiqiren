const { getDoudianConfig } = require('../../shared/config');
const { NOISE_SHOP_NAMES } = require('./doudian-shop-resolver');

const BLOCKED_SHOP_IDS = new Set(['213196845']);
const BLOCKED_SHOP_NAMES = new Set(['实时', '当前会话', '最近联系', '飞鸽客服系统']);

function normalizeShopArray(value) {
  if (Array.isArray(value)) return value;
  return [];
}

function collectShopEntries(report) {
  return {
    loggedInShops: normalizeShopArray(report.loggedInShops),
    activeImShops: normalizeShopArray(report.activeImShops),
    inactiveShops: normalizeShopArray(report.inactiveShops),
    unknownBridges: normalizeShopArray(report.unknownBridges),
    unknownImBridges: normalizeShopArray(report.unknownImBridges),
  };
}

function inspectShopEntry(shop, arrayName, knownIds, errors, badShopIds, badShopNames) {
  const id = String(shop?.shopId ?? '').trim();
  const name = String(shop?.shopName ?? '').trim();

  if (!id) {
    errors.push(`${arrayName} 存在空 shopId 假店铺`);
    if (name) badShopNames.push(name);
    return;
  }

  if (BLOCKED_SHOP_IDS.has(id)) {
    errors.push(`${arrayName} 包含禁止 shopId: ${id}`);
    badShopIds.push(id);
  }

  if (!knownIds.has(id)) {
    errors.push(`${arrayName} 包含未知 shopId: ${id}，不在 knownShops`);
    badShopIds.push(id);
  }

  for (const blocked of BLOCKED_SHOP_NAMES) {
    if (name === blocked || name.includes(blocked)) {
      errors.push(`${arrayName} 包含禁止店名: ${name}`);
      badShopNames.push(name);
    }
  }

  if (name && NOISE_SHOP_NAMES.test(name)) {
    errors.push(`${arrayName} 包含噪音店名: ${name}`);
    badShopNames.push(name);
  }
}

function validateShopReport(report = {}, options = {}) {
  const knownShops = options.knownShops || getDoudianConfig().knownShops || [];
  const knownIds = new Set(knownShops.map((ks) => String(ks.shopId)).filter(Boolean));
  const requiredLoggedInCount =
    options.requiredLoggedInCount ?? (knownShops.length > 0 ? knownShops.length : 2);

  const errors = [];
  const badShopIds = [];
  const badShopNames = [];
  const shops = collectShopEntries(report);

  const loggedInCount = Number(report.loggedInShopCount ?? shops.loggedInShops.length);
  const activeImCount = Number(report.activeImShopCount ?? shops.activeImShops.length);
  const inactiveCount = Number(report.inactiveShopCount ?? shops.inactiveShops.length);

  if (loggedInCount !== requiredLoggedInCount) {
    errors.push(
      `loggedInShopCount 应为 ${requiredLoggedInCount}，实际为 ${loggedInCount}`
    );
  }

  if (shops.loggedInShops.length !== loggedInCount) {
    errors.push(
      `loggedInShops 数组长度(${shops.loggedInShops.length}) 与 loggedInShopCount(${loggedInCount}) 不一致`
    );
  }

  if (activeImCount > 2) {
    errors.push(`activeImShopCount 不能超过 2，实际为 ${activeImCount}`);
  }

  if (activeImCount + inactiveCount !== loggedInCount) {
    errors.push(
      `activeImShopCount(${activeImCount}) + inactiveShopCount(${inactiveCount}) 必须等于 loggedInShopCount(${loggedInCount})`
    );
  }

  for (const shop of shops.loggedInShops) {
    inspectShopEntry(shop, 'loggedInShops', knownIds, errors, badShopIds, badShopNames);
  }
  for (const shop of shops.activeImShops) {
    inspectShopEntry(shop, 'activeImShops', knownIds, errors, badShopIds, badShopNames);
  }
  for (const shop of shops.inactiveShops) {
    inspectShopEntry(shop, 'inactiveShops', knownIds, errors, badShopIds, badShopNames);
  }

  const loggedInIds = new Set(shops.loggedInShops.map((s) => String(s.shopId)).filter(Boolean));
  for (const shop of shops.activeImShops) {
    const id = String(shop.shopId || '');
    if (id && !loggedInIds.has(id)) {
      errors.push(`activeImShops 中的 shopId ${id} 未出现在 loggedInShops`);
    }
  }
  for (const shop of shops.inactiveShops) {
    const id = String(shop.shopId || '');
    if (id && !loggedInIds.has(id)) {
      errors.push(`inactiveShops 中的 shopId ${id} 未出现在 loggedInShops`);
    }
  }

  const activeIds = new Set(shops.activeImShops.map((s) => String(s.shopId)).filter(Boolean));
  for (const shop of shops.inactiveShops) {
    const id = String(shop.shopId || '');
    if (id && activeIds.has(id)) {
      errors.push(`inactiveShops 与 activeImShops 重复 shopId: ${id}`);
    }
  }

  const unknownBridgeIds = new Set(
    [...shops.unknownBridges, ...shops.unknownImBridges]
      .map((b) => String(b?.bridgeId || ''))
      .filter(Boolean)
  );
  if (unknownBridgeIds.size > 0) {
    const shopCountIncludesUnknown =
      Number(report.shopCount ?? 0) > loggedInCount &&
      loggedInCount + unknownBridgeIds.size <= Number(report.shopCount ?? 0);
    if (shopCountIncludesUnknown) {
      errors.push('unknown bridge 被计入 shopCount');
    }
  }

  const knownShopOnly =
    badShopIds.length === 0 &&
    shops.loggedInShops.every((s) => knownIds.has(String(s.shopId))) &&
    shops.activeImShops.every((s) => knownIds.has(String(s.shopId))) &&
    shops.inactiveShops.every((s) => knownIds.has(String(s.shopId)));

  const unknownExcluded =
    !shops.loggedInShops.some((s) => !s.shopId || BLOCKED_SHOP_IDS.has(String(s.shopId))) &&
    !shops.activeImShops.some((s) => !s.shopId || BLOCKED_SHOP_IDS.has(String(s.shopId))) &&
    !shops.inactiveShops.some((s) => !s.shopId || BLOCKED_SHOP_IDS.has(String(s.shopId)));

  const uniqueBadShopIds = [...new Set(badShopIds)];
  const uniqueBadShopNames = [...new Set(badShopNames)];

  const imBridgeSeen = Number(report.imBridgeSeen || 0);
  const unknownImBridgeCount = shops.unknownImBridges.length;
  const imBridgeResolveChecked = true;
  const activeImShopCountReasonable =
    imBridgeSeen === 0 ||
    activeImCount > 0 ||
    unknownImBridgeCount > 0;

  if (imBridgeSeen > 0 && activeImCount === 0 && unknownImBridgeCount === 0) {
    errors.push('存在 IM bridge 但未产出 activeImShops 或 unknownImBridges 诊断');
  }
  if (imBridgeSeen > 0 && activeImCount + unknownImBridgeCount <= 0) {
    errors.push('IM bridge 被静默丢失，activeImShopCount + unknownImBridgeCount 必须大于 0');
  }

  return {
    success: errors.length === 0,
    loggedInShopCount: loggedInCount,
    activeImShopCount: activeImCount,
    inactiveShopCount: inactiveCount,
    knownShopOnly,
    unknownExcluded,
    badShopIds: uniqueBadShopIds,
    badShopNames: uniqueBadShopNames,
    imBridgeResolveChecked,
    imBridgeSeen,
    unknownImBridgeCount,
    activeImShopCountReasonable,
    errors,
  };
}

function applyShopReportValidation(report, validation) {
  report.shopReportValid = validation.success;
  report.shopReportErrors = validation.errors;
  return report;
}

module.exports = {
  BLOCKED_SHOP_IDS,
  BLOCKED_SHOP_NAMES,
  validateShopReport,
  applyShopReportValidation,
};
