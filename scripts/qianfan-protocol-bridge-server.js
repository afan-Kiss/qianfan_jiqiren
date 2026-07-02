#!/usr/bin/env node
/**
 * 千帆纯协议桥接（祥钰 bridge-relay 替代，不依赖本地 CDP）
 */
const { createProtocolBridgeServer } = require('../src/protocol/qianfan-protocol-bridge-server');
const { println } = require('../src/utils');

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('用法: node scripts/qianfan-protocol-bridge-server.js');
    console.log('环境变量:');
    console.log('  QIANFAN_PROTOCOL_BRIDGE_HOST=0.0.0.0');
    console.log('  QIANFAN_PROTOCOL_BRIDGE_PORT=35872');
    console.log('  QIANFAN_PROTOCOL_BRIDGE_PRODUCTION=1  # 允许对任意买家发送');
    process.exit(0);
  }

  if (!process.env.QIANFAN_PROTOCOL_BRIDGE_PRODUCTION) {
    process.env.QIANFAN_PROTOCOL_BRIDGE_PRODUCTION = '1';
  }

  const bridge = createProtocolBridgeServer();
  const shutdown = async (signal) => {
    println(`[protocol-bridge] 收到 ${signal}，退出中...`);
    try {
      await bridge.stop();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await bridge.start();
  println('[protocol-bridge] 已启动，祥钰可配置 bridge.url=http://服务器:35872/send');
}

main().catch((err) => {
  console.error('[protocol-bridge] 启动失败:', err.message || err);
  process.exit(1);
});
