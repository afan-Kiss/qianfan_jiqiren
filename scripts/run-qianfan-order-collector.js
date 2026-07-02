#!/usr/bin/env node
/**
 * 千帆订单采集系统 — 独立 HTTP 服务
 * 用法: node scripts/run-qianfan-order-collector.js [--host 127.0.0.1] [--port 9325]
 */
const { createOrderCollectorServer } = require('../src/protocol/qianfan-order-collector-server');

function parseArgs(argv) {
  const out = { help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--host') out.host = String(argv[++i] || '').trim();
    else if (a === '--port') out.port = Number(argv[++i]) || 9325;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法: node scripts/run-qianfan-order-collector.js [--host 127.0.0.1] [--port 9325]');
    process.exit(0);
  }
  const app = createOrderCollectorServer({ host: args.host, port: args.port });
  await app.start();
}

main().catch((err) => {
  console.error('[订单采集] 启动失败:', err.message || err);
  process.exit(1);
});
