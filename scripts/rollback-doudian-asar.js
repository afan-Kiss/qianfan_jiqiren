#!/usr/bin/env node
/**
 * 回滚 asar patch
 */
const { rollbackAsarPatch } = require('../src/platforms/doudian/doudian-asar-patcher');

async function main() {
  const installDir = process.argv[2];
  if (!installDir) {
    console.error('用法: node scripts/rollback-doudian-asar.js "<安装目录>"');
    process.exit(1);
  }
  const result = await rollbackAsarPatch(installDir);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
