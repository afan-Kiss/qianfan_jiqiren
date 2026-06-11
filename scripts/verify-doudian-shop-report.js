#!/usr/bin/env node
/**
 * 校验抖店报告中的店铺统计是否仅包含 knownShops
 * npm run doudian:verify-shop-report
 * node scripts/verify-doudian-shop-report.js logs/doudian-wait-real-message-latest.json
 */
const fs = require('fs');
const path = require('path');
const { getDoudianConfig } = require('../src/shared/config');
const {
  validateShopReport,
  BLOCKED_SHOP_IDS,
  BLOCKED_SHOP_NAMES,
} = require('../src/platforms/doudian/doudian-shop-report-validator');

function resolveReportPath(argv = []) {
  const arg = argv.find((a) => a && !a.startsWith('-'));
  if (arg) return path.resolve(process.cwd(), arg);
  return path.join(process.cwd(), 'logs', 'doudian-wait-real-message-latest.json');
}

function main() {
  const reportPath = resolveReportPath(process.argv.slice(2));
  if (!fs.existsSync(reportPath)) {
    const output = {
      success: false,
      errors: [`报告文件不存在: ${reportPath}`],
      badShopIds: [],
      badShopNames: [],
    };
    console.log(JSON.stringify(output, null, 2));
    process.exit(1);
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (err) {
    const output = {
      success: false,
      errors: [`报告 JSON 解析失败: ${err.message}`],
      badShopIds: [],
      badShopNames: [],
    };
    console.log(JSON.stringify(output, null, 2));
    process.exit(1);
  }

  const cfg = getDoudianConfig();
  const validation = validateShopReport(report, { knownShops: cfg.knownShops || [] });

  const output = {
    ...validation,
    reportPath,
    hasBlockedShopId213196845:
      validation.badShopIds.includes('213196845') ||
      [...BLOCKED_SHOP_IDS].some((id) =>
        [...(report.loggedInShops || []), ...(report.activeImShops || []), ...(report.inactiveShops || [])].some(
          (s) => String(s?.shopId) === id
        )
      ),
    hasBlockedShopName实时: validation.badShopNames.some((n) => n.includes('实时')) ||
      [...(report.loggedInShops || []), ...(report.activeImShops || []), ...(report.inactiveShops || [])].some(
        (s) => String(s?.shopName || '').includes('实时')
      ),
    imBridgeResolveChecked: validation.imBridgeResolveChecked,
    imBridgeSeen: validation.imBridgeSeen,
    unknownImBridgeCount: validation.unknownImBridgeCount,
    activeImShopCountReasonable: validation.activeImShopCountReasonable,
  };

  console.log(JSON.stringify(output, null, 2));
  process.exit(validation.success ? 0 : 1);
}

main();
