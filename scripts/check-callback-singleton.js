const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const errors = [];

function check(cond, message) {
  if (!cond) errors.push(message);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const workersDir = path.join(ROOT, 'src', 'workers');
const workerFiles = fs.readdirSync(workersDir).filter((name) => name.endsWith('.worker.js'));

let callbackStarterCount = 0;
for (const file of workerFiles) {
  const src = read(path.join('src/workers', file));
  if (src.includes('startCallbackServer') || src.includes('startWxbotCallbackServer')) {
    callbackStarterCount += 1;
    check(file === 'wechat-callback.worker.js', `${file} 不应启动 callback server`);
  }
}

check(callbackStarterCount === 1, 'distributed runtime 下只能有一个 worker 启动 callback server');

const adapter = read('src/adapters/legacy-wechat-callback-adapter.js');
check(adapter.includes('activeServer'), 'callback adapter 必须维护单例 activeServer');
check(adapter.includes('stopCallbackServer'), 'callback adapter 必须提供 stopCallbackServer');
check(adapter.includes('QIANFAN_RUNTIME_MODE'), 'callback adapter 必须识别 distributed runtime');

const runner = read('src/runtime/worker-runner.js');
check(runner.includes("QIANFAN_RUNTIME_MODE: 'distributed'"), 'worker-runner 必须注入 distributed 环境变量');

const oneclick = read('src/wxbot-new-oneclick.js');
check(oneclick.includes('startWxbotCallbackServer'), 'CLI 回退路径仍保留 callback 启动');

if (errors.length) {
  console.error('[check-callback-singleton] FAILED');
  for (const err of errors) console.error(`- ${err}`);
  process.exit(1);
}

console.log('[check-callback-singleton] OK');
