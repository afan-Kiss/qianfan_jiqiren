#!/usr/bin/env node
/**
 * 校验 asar patch 是否写入 app.asar 内部目标文件
 */
const { verifyAsarPatch } = require('../src/platforms/doudian/doudian-asar-patch-verify');
const { getDoudianConfig } = require('../src/shared/config');

function printLine(label, value) {
  console.log(`${label}: ${value}`);
}

function main() {
  const installDir = process.argv[2];
  if (!installDir) {
    console.error('用法: node scripts/verify-doudian-asar-patch.js "<安装目录>"');
    console.error('示例: node scripts/verify-doudian-asar-patch.js "D:\\抖店工作台_patch_test\\1.1.7-login.1"');
    process.exit(1);
  }

  const cfg = getDoudianConfig();
  const verify = verifyAsarPatch(installDir, { bridgePort: cfg.bridgePort });

  console.log('=== 抖店 asar patch 校验 ===\n');
  printLine('安装目录', verify.installDir);
  printLine('app.asar 存在', verify.appAsarExists ? '是' : '否');
  printLine('app.asar.backup 存在', verify.backupAsarExists ? '是' : '否');
  printLine('md5.json.backup 存在', verify.backupMd5Exists ? '是' : '否');
  printLine('bridgePort', verify.bridgePort);
  printLine('期望 WS URL', verify.expectedWsUrl);
  printLine('注入标记校验', verify.markerCheckPassed ? '通过' : '失败');
  printLine('WS URL 校验', verify.wsUrlCheckPassed ? '通过' : '失败');
  printLine('整体校验', verify.ok ? '通过' : '失败');

  console.log('\n--- 注入文件（app.asar 内部）---');
  for (const f of verify.patchedFiles) {
    console.log(`\n${f.displayPath}`);
    printLine('  存在于 asar', f.existsInAsar ? '是' : '否');
    printLine('  __DOUDIAN_BRIDGE_PATCH__', f.hasPatchMarker ? '是' : '否');
    printLine('  __DOUDIAN_PRELOAD_PATCH_TEST__', f.hasPreloadTestFlag ? '是' : '否');
    printLine('  ws URL 字符串', f.hasWsUrl ? '是' : '否');
    printLine('  文件校验', f.ok ? '通过' : '失败');
    if (f.error) printLine('  错误', f.error);
  }

  console.log('\n--- md5 风险 ---');
  printLine('md5.json 存在', verify.md5.md5FileExists ? '是' : '否');
  printLine('可能校验 app.asar', verify.md5.mayValidateAppAsar ? '是' : '否');
  printLine('说明', verify.md5.note);

  if (verify.meta) {
    console.log('\n--- patch meta ---');
    printLine('patchedAt', verify.meta.patchedAt || '(无)');
    printLine('patchMode', verify.meta.patchMode || '(无)');
    printLine('targetFiles', (verify.meta.targetFiles || []).join(', '));
  }

  process.exit(verify.ok ? 0 : 1);
}

main();
