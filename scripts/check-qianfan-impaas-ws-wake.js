const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const errors = [];

function assert(cond, message) {
  if (!cond) errors.push(message);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function main() {
  const bridge = read('src/qianfan-ws-bridge.js');
  const listener = read('src/qianfan-message-listener.js');

  assert(bridge.includes('ensureImpaasWsReady'), 'ws-bridge must warm impaas ws before send');
  assert(bridge.includes('probePageImpaasWs'), 'ws-bridge must probe page runtime sockets');
  assert(bridge.includes('registerShopReconnectWake'), 'ws-bridge must expose shop reconnect wake');
  assert(listener.includes('registerShopReconnectWake'), 'listener must register reconnect wake for send retry');
  assert(bridge.includes('findBridgeByShopTitle(shopTitle) || bridge'), 'send must refresh bridge after reconnect');

  if (errors.length) {
    console.error('[check-qianfan-impaas-ws-wake] FAILED');
    for (const err of errors) console.error(`- ${err}`);
    process.exit(1);
  }

  console.log('[check-qianfan-impaas-ws-wake] OK');
}

main();
