#!/usr/bin/env node
/**
 * 启用 asar patch（极简诊断版）
 * 用法:
 *   node scripts/patch-doudian-asar.js "D:\抖店工作台_patch_test\1.1.7-login.1"
 *   node scripts/patch-doudian-asar.js "D:\抖店工作台\1.1.7-login.1" --force-original
 */
const { applyAsarPatch } = require('../src/platforms/doudian/doudian-asar-patcher');

async function main() {
  const args = process.argv.slice(2);
  const installDir = args.find((a) => !a.startsWith('--'));
  const force = args.includes('--force');
  const forceOriginal = args.includes('--force-original');

  if (!installDir) {
    console.error('用法: node scripts/patch-doudian-asar.js "<安装目录>" [--force] [--force-original]');
    process.exit(1);
  }

  const result = await applyAsarPatch(installDir, { force, forceOriginal });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
