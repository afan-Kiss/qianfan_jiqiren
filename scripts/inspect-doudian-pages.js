#!/usr/bin/env node
/**
 * 扫描本机 DevTools 页面，标记疑似抖店客服页
 * 用法：node scripts/inspect-doudian-pages.js
 */
const { findActiveDevToolsPort } = require('../src/shared/devtools-probe');
const { detectDoudianProcesses } = require('../src/platforms/doudian/doudian-process-detector');
const { findDoudianPages, classifyPagePlatform } = require('../src/platforms/doudian/doudian-page-finder');

async function main() {
  console.log('=== 抖店页面探测 ===\n');

  const proc = detectDoudianProcesses();
  console.log(`进程：found=${proc.found} count=${proc.count}`);
  for (const p of proc.processes) {
    console.log(`  - pid=${p.pid} name=${p.processName} title=${p.mainWindowTitle || '(无标题)'} matchedBy=${p.matchedBy}`);
  }
  console.log('');

  const scan = await findActiveDevToolsPort({ preferDoudianPages: true });
  console.log(`DevTools 扫描：active=${scan.active.length}`);
  for (const probe of scan.probes) {
    console.log(`  - ${probe.host}:${probe.port} ok=${probe.ok} pages=${probe.pageCount || 0} reason=${probe.reason || ''}`);
  }
  console.log('');

  if (!scan.best) {
    console.log('未发现可用 DevTools 端口。请确认抖店客户端已开启远程调试。');
    process.exit(1);
  }

  const best = scan.best;
  const pages = best.pages || [];
  console.log(`使用端口 ${best.host}:${best.port}，共 ${pages.length} 个 page\n`);

  const report = findDoudianPages(pages, { devtoolsPort: best.port });

  for (const page of pages) {
    const platform = classifyPagePlatform(page);
    const related = report.relatedPages.find((p) => p.url === page.url && p.title === page.title);
    const service = report.servicePages.find((p) => p.url === page.url && p.title === page.title);
    const flags = [];
    if (service) flags.push('★客服页');
    else if (related) flags.push('相关页');

    console.log('---');
    console.log(`title: ${page.title || '(无标题)'}`);
    console.log(`url: ${page.url || ''}`);
    console.log(`platform: ${platform}`);
    console.log(`flags: ${flags.join(', ') || '-'}`);
    console.log(`webSocketDebuggerUrl: ${page.webSocketDebuggerUrl || ''}`);
  }

  console.log('\n=== 汇总 ===');
  console.log(`抖店相关页: ${report.relatedPageCount}`);
  console.log(`抖店客服页: ${report.servicePageCount}`);
  if (report.bestServicePage) {
    console.log(`推荐注入页: ${report.bestServicePage.title} | ${report.bestServicePage.url}`);
  } else if (report.relatedPages[0]) {
    console.log(`候选页（非严格客服特征）: ${report.relatedPages[0].title} | ${report.relatedPages[0].url}`);
  }
}

main().catch((err) => {
  console.error('探测失败：', err.message || err);
  process.exit(1);
});
