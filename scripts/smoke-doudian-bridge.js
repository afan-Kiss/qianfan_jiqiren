#!/usr/bin/env node
/**
 * 抖店桥冒烟测试 — 仅验证 bridge.hello / bridge.ready / bridge.heartbeat
 * 用法：npm run smoke:doudian
 */
const { getDoudianWsServer } = require('../src/platforms/doudian');
const { BRIDGE_EVENTS } = require('../src/platforms/doudian/doudian-types');
const { getDoudianConfig } = require('../src/shared/config');

const WATCH_TYPES = new Set([
  BRIDGE_EVENTS.HELLO,
  BRIDGE_EVENTS.READY,
  BRIDGE_EVENTS.HEARTBEAT,
]);

function logBridgeEvent(label, envelope) {
  console.log(`\n[${label}] ${new Date().toISOString()}`);
  console.log(JSON.stringify(envelope, null, 2));
}

async function main() {
  const cfg = getDoudianConfig();

  console.log('=== 抖店桥冒烟测试（仅 hello/ready/heartbeat）===');
  console.log(`WS: ws://127.0.0.1:${cfg.bridgePort}/doudian/bridge`);
  console.log('');
  console.log('前置条件：');
  console.log('  1. 已对测试目录执行 patch 并通过 verify');
  console.log('  2. 已从测试目录启动 doudian.exe');
  console.log('  3. 已打开客服工作台页面');
  console.log('');

  const wsServer = getDoudianWsServer({ port: cfg.bridgePort });
  await wsServer.start();

  for (const type of WATCH_TYPES) {
    wsServer.on(type, (envelope) => logBridgeEvent(type, envelope));
  }

  wsServer.on(BRIDGE_EVENTS.ERROR, (envelope) => {
    console.log('\n[bridge.error]', JSON.stringify(envelope, null, 2));
  });

  let helloCount = 0;
  let readyCount = 0;
  let heartbeatCount = 0;

  wsServer.on(BRIDGE_EVENTS.HELLO, () => { helloCount += 1; });
  wsServer.on(BRIDGE_EVENTS.READY, () => { readyCount += 1; });
  wsServer.on(BRIDGE_EVENTS.HEARTBEAT, () => { heartbeatCount += 1; });

  console.log('等待 bridge 事件（120s）...\n');

  const started = Date.now();
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      const bridge = wsServer.getPrimaryBridge();
      console.log(
        `[poll ${elapsed}s] connected=${Boolean(bridge)} bridgeId=${bridge?.bridgeId || ''} ` +
          `hello=${helloCount} ready=${readyCount} heartbeat=${heartbeatCount}`
      );
      if (elapsed >= 120) {
        clearInterval(timer);
        resolve();
      }
    }, 5000);
  });

  console.log('\n=== 汇总 ===');
  console.log(`bridge.hello 收到: ${helloCount}`);
  console.log(`bridge.ready 收到: ${readyCount}`);
  console.log(`bridge.heartbeat 收到: ${heartbeatCount}`);

  if (helloCount > 0) {
    console.log('\n✓ bridge.hello 已打通');
  } else {
    console.log('\n✗ 未收到 bridge.hello — 请检查 patch、客户端是否从测试目录启动、客服页是否打开');
  }

  await wsServer.stop();
  process.exit(helloCount > 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('冒烟测试异常：', err.message || err);
  process.exit(1);
});
