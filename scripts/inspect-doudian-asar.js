#!/usr/bin/env node
/**
 * 抖店 app.asar 安全分析（只读，不修改）
 * 用法：node scripts/inspect-doudian-asar.js "D:\抖店工作台\1.1.7-login.1"
 */
const path = require('path');
const { probeCdpRoute } = require('../src/platforms/doudian/doudian-cdp-probe');
const { analyzeDoudianInstall } = require('../src/platforms/doudian/doudian-asar-analyzer');
const { getPatchStatus } = require('../src/platforms/doudian/doudian-asar-patcher');

function printSection(title) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  const installDir = process.argv[2];
  if (!installDir) {
    console.error('用法: node scripts/inspect-doudian-asar.js "<抖店安装目录>"');
    console.error('示例: node scripts/inspect-doudian-asar.js "D:\\抖店工作台\\1.1.7-login.1"');
    process.exit(1);
  }

  printSection('CDP 探测');
  const cdp = await probeCdpRoute({ stopOnFirstDoudian: true });
  console.log(`CDP 可用: ${cdp.available}`);
  console.log(`CDP 可注入: ${cdp.canInject}`);
  console.log(`CDP 原因: ${cdp.reason}`);
  if (cdp.scan?.active?.length) {
    for (const p of cdp.scan.active) {
      console.log(`  - ${p.host}:${p.port} pages=${p.pageCount}`);
    }
  } else {
    console.log('  未发现 DevTools 监听端口（抖店可能未开放 CDP）');
  }

  printSection('app.asar 分析');
  const report = analyzeDoudianInstall(installDir, { cdpHint: cdp });
  if (!report.ok) {
    console.error('分析失败:', report.message || report.reason);
    process.exit(1);
  }

  console.log(`安装目录: ${report.installDir}`);
  console.log(`app.asar 文件数: ${report.asarFileCount}`);
  console.log(`已扫描文本文件: ${report.scannedFileCount}`);
  console.log(`配置发现: ${report.configFiles.map((c) => c.name).join(', ') || '(无)'}`);

  printSection('疑似入口文件');
  const entries = report.entryCandidates
    .filter((c) => c.exists)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
  for (const e of entries) {
    console.log(`- [score=${e.score}] ${e.file} (size=${e.size})`);
    const kws = [...new Set((e.hits || []).map((h) => h.keyword))];
    if (kws.length) console.log(`    keywords: ${kws.join(', ')}`);
  }

  printSection('关键词命中（Top 文件）');
  const hitFiles = Object.entries(report.keywordHitsByFile)
    .sort((a, b) => b[1].hits.length - a[1].hits.length)
    .slice(0, 12);
  for (const [file, info] of hitFiles) {
    console.log(`\n# ${file} (hits=${info.hits.length}, size=${info.size})`);
    for (const h of info.hits.slice(0, 6)) {
      console.log(`  L${h.line} [${h.keyword}] ${h.snippet}`);
    }
  }

  printSection('优先 URL 命中');
  if (!report.priorityUrlHits.length) {
    console.log('(无直接命中，见 webview_preload_vendor.js 配置段)');
  } else {
    for (const hit of report.priorityUrlHits) {
      console.log(`- ${hit.url} @ ${hit.file}`);
    }
  }

  const patchStatus = getPatchStatus(installDir);
  const rec = report.recommendations;

  printSection('分析报告');
  console.log(`是否能走 CDP: ${rec.canUseCdp ? '是' : '否'}`);
  console.log(`是否需要 asar 注入: ${rec.needAsarInject ? '是' : '否'}`);
  console.log(`当前 asar 已 patch: ${patchStatus.patched ? '是' : '否'}`);
  console.log(`推荐注入点: ${rec.recommendedInjectPoint?.file || '(待确认)'}`);
  if (rec.recommendedInjectPoint?.reason) {
    console.log(`  原因: ${rec.recommendedInjectPoint.reason}`);
  }
  console.log(`推荐监听页面: ${rec.recommendedListenPage}`);
  console.log(`推荐发送页面: ${rec.recommendedSendPage}`);
  console.log(`推荐 patch 目标: ${rec.recommendedPatchTarget}`);

  printSection('下一步');
  if (rec.canUseCdp) {
    console.log('1. 优先使用 CDP 路线：确保抖店 DevTools 端口可访问后运行 smoke 脚本');
  } else {
    console.log('1. CDP 不可用：需在 config.json 设置 doudian.installDir');
    console.log('2. 分析完成后，设置 doudian.enableAsarPatch=true');
    console.log('3. 运行: node scripts/patch-doudian-asar.js "<安装目录>"');
    console.log('4. 重启抖店客户端，打开客服工作台页面');
    console.log('5. 运行: npm run smoke:doudian');
  }
  console.log('回滚: node scripts/rollback-doudian-asar.js "<安装目录>"');

  const outFile = path.join(process.cwd(), 'logs', `doudian-asar-report-${Date.now()}.json`);
  try {
    const fs = require('fs');
    const dir = path.dirname(outFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      outFile,
      JSON.stringify({ cdp, report, patchStatus, recommendations: rec }, null, 2),
      'utf8'
    );
    console.log(`\n完整报告已写入: ${outFile}`);
  } catch {
    // ignore
  }
}

main().catch((err) => {
  console.error('分析异常:', err.message || err);
  process.exit(1);
});
