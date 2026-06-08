const path = require('path');
const fs = require('fs');
const { TOPIC_ROUTES, WORKER_TOPIC_SUBSCRIPTIONS } = require('../src/runtime/worker-registry');

const ROOT = path.resolve(__dirname, '..');
const errors = [];

function check(cond, message) {
  if (!cond) errors.push(message);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

for (const [workerName, topics] of Object.entries(WORKER_TOPIC_SUBSCRIPTIONS)) {
  const workerFile = path.join(ROOT, 'src/workers', `${workerName}.worker.js`);
  if (!fs.existsSync(workerFile)) {
    errors.push(`缺少 worker 文件: ${workerName}.worker.js`);
    continue;
  }
  const src = read(`src/workers/${workerName}.worker.js`);
  for (const topic of topics) {
    if (!src.includes(`'${topic}'`) && !src.includes(`"${topic}"`)) {
      errors.push(`${workerName}.worker.js 应订阅 topic: ${topic}`);
    }
  }
}

if (!TOPIC_ROUTES['buyer-message.detected']?.includes('wechat-notifier')) {
  errors.push('TOPIC_ROUTES 缺少 buyer-message.detected -> wechat-notifier');
}

const rendererApp = read('src/renderer/app.js');
check(!rendererApp.includes("require('../"), 'renderer 不应 require 后端文件');
check(!rendererApp.includes('require("./'), 'renderer 不应 require 后端文件');

const supervisorSrc = read('src/runtime/supervisor.js');
const forbiddenInSupervisor = [
  'qianfan-message-listener',
  'qianfan-wechat-notifier',
  'wechat-to-qianfan-reply',
  'wxbot-new-callback-server',
  'qianfan-ws-bridge',
];
for (const token of forbiddenInSupervisor) {
  check(!supervisorSrc.includes(token), `supervisor 不应 require ${token}`);
}

const listenerWorker = read('src/workers/qianfan-listener.worker.js');
check(!listenerWorker.includes('legacy-wechat-notifier-adapter'), 'qianfan-listener 不应直接 require notifier adapter');

const replyWorker = read('src/workers/wechat-reply.worker.js');
check(!replyWorker.includes('sendQianfanReplyRequest'), 'wechat-reply 不应直接调用千帆发送');
check(!replyWorker.includes('qianfan-ws-bridge'), 'wechat-reply 不应 direct require qianfan-ws-bridge');

const senderWorker = read('src/workers/qianfan-sender.worker.js');
check(!senderWorker.includes('renderer/'), 'qianfan-sender 不应引用 UI 文件');
check(!senderWorker.includes('sendQianfanReplyRequest'), 'qianfan-sender 不应直接调用千帆发送（bridge 在 listener 进程）');

const listenerWorkerSend = read('src/workers/qianfan-listener.worker.js');
check(listenerWorkerSend.includes('sendQianfanReplyRequest'), 'qianfan-listener 应负责千帆发送');
check(listenerWorkerSend.includes('qianfan.send.execute'), 'qianfan-listener 应订阅 qianfan.send.execute');

const workerNames = fs
  .readdirSync(path.join(ROOT, 'src/workers'))
  .filter((name) => name.endsWith('.worker.js') && name !== 'worker-bootstrap.js');

for (const file of workerNames) {
  const src = read(path.join('src/workers', file));
  const otherWorkers = workerNames.filter((name) => name !== file);
  for (const other of otherWorkers) {
    check(!src.includes(`./${other.replace('.js', '')}`), `${file} 不应 require ${other}`);
  }
}

if (errors.length) {
  console.error('[check-worker-boundaries] FAILED');
  for (const err of errors) console.error(`- ${err}`);
  process.exit(1);
}

console.log('[check-worker-boundaries] OK');
