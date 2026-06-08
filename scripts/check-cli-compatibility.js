const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function main() {
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  assert.ok(pkg.scripts['start:cli'], 'package.json 必须保留 start:cli');
  assert.ok(fs.existsSync(path.join(ROOT, 'src/wxbot-new-oneclick.js')), 'wxbot-new-oneclick.js 必须存在');

  const ipcBridge = read(path.join(ROOT, 'src/main/ipc-bridge.js'));
  assert.ok(ipcBridge.includes('RuntimeSupervisor'), 'distributed runtime 应使用 RuntimeSupervisor');
  assert.ok(!ipcBridge.includes('wxbot-new-oneclick'), 'distributed runtime 不应 spawn wxbot-new-oneclick.js');

  const notifier = read(path.join(ROOT, 'src/qianfan-wechat-notifier.js'));
  assert.ok(notifier.includes('persistHooks'), 'persistHooks 应为可选参数');
  assert.ok(notifier.includes('options.persistHooks'), 'persistHooks 来自 options');

  const oneclick = read(path.join(ROOT, 'src/wxbot-new-oneclick.js'));
  assert.ok(!oneclick.includes('runtime/supervisor'), 'CLI 路径不应 require runtime/supervisor');

  const { createQianfanWechatNotifier } = require('../src/qianfan-wechat-notifier');
  assert.doesNotThrow(() => createQianfanWechatNotifier({ enabled: true }), '未传 persistHooks 时不应 throw');

  console.log('[check-cli-compatibility] passed');
}

main();
