#!/usr/bin/env node
/**
 * 打包最近 N 分钟的协议抓包 JSONL → 单个 JSON，便于提交分析
 * 用法：node scripts/bundle-qianfan-protocol-tap.js [--minutes 10]
 */
const { bundleProtocolTap, getProtocolTapStatus } = require('../src/capture/qianfan-protocol-tap');

function pickMinutes(argv) {
  const idx = argv.indexOf('--minutes');
  if (idx >= 0 && argv[idx + 1]) return Math.max(1, Number(argv[idx + 1]) || 10);
  return 10;
}

const minutes = pickMinutes(process.argv.slice(2));
const sinceMs = minutes * 60 * 1000;
const status = getProtocolTapStatus();
const result = bundleProtocolTap({ sinceMs });

if (!result.ok) {
  console.error('[协议抓包] 打包失败:', result.error, result.logPath || '');
  process.exit(1);
}

console.log('[协议抓包] 状态:', JSON.stringify(status, null, 2));
console.log(`[协议抓包] 已打包最近 ${minutes} 分钟 ${result.rowCount} 条 → ${result.outPath}`);
