const path = require('path');
const { MessageBus } = require('../src/runtime/message-bus');
const { RuntimeSupervisor } = require('../src/runtime/supervisor');
const { getTopicTargets } = require('../src/runtime/worker-registry');

const ROOT = path.resolve(__dirname, '..');
const errors = [];

function assert(cond, message) {
  if (!cond) errors.push(message);
}

function createMockRunner(workerName) {
  return {
    workerName,
    sent: [],
    pid: 12345,
    send(message) {
      this.sent.push(message);
      return true;
    },
    getStatus() {
      return { workerName, status: 'running', pid: this.pid };
    },
  };
}

function lastSent(runner, topic) {
  return runner.sent.filter((item) => item.type === 'bus.message' && item.topic === topic);
}

async function main() {
  const bus = new MessageBus();
  const published = [];
  bus.on('published', (message) => published.push(message));

  const routedBuyer = bus.routeFromWorker('qianfan-listener', {
    type: 'bus.publish',
    topic: 'buyer-message.detected',
    payload: { message: { id: 'buyer-1' }, options: {} },
    meta: { traceId: 'trace-buyer-001' },
  });

  assert(routedBuyer?.type === 'bus.published', 'buyer-message.detected 应被 supervisor 路由');
  assert(
    published.some((item) => item.topic === 'buyer-message.detected' && item.meta.traceId === 'trace-buyer-001'),
    'buyer-message.detected 应保留 traceId',
  );
  assert(
    getTopicTargets('buyer-message.detected').includes('wechat-notifier'),
    'buyer-message.detected 目标 worker 必须是 wechat-notifier',
  );

  const supervisor = new RuntimeSupervisor({ rootDir: ROOT });
  supervisor.registerDefaultWorkers();

  const notifierRunner = createMockRunner('wechat-notifier');
  const replyRunner = createMockRunner('wechat-reply');
  const senderRunner = createMockRunner('qianfan-sender');
  supervisor.runners.set('wechat-notifier', notifierRunner);
  supervisor.runners.set('wechat-reply', replyRunner);
  supervisor.runners.set('qianfan-sender', senderRunner);

  supervisor.handleWorkerMessage('qianfan-listener', {
    type: 'bus.publish',
    topic: 'buyer-message.detected',
    payload: { message: { id: 'buyer-1' }, options: {} },
    meta: { traceId: 'trace-buyer-001' },
  });

  assert(lastSent(notifierRunner, 'buyer-message.detected').length > 0, 'supervisor 应转发 buyer 流到 wechat-notifier');
  assert(
    lastSent(notifierRunner, 'buyer-message.detected')[0]?.meta?.traceId === 'trace-buyer-001',
    '转发到 wechat-notifier 必须保留 traceId',
  );

  supervisor.handleWorkerMessage('wechat-callback', {
    type: 'bus.publish',
    topic: 'wechat.reply.received',
    payload: { parsed: { from: 'wxid_test' }, body: {} },
    meta: { traceId: 'trace-reply-001' },
  });

  assert(lastSent(replyRunner, 'wechat.reply.received').length > 0, 'wechat.reply.received 应路由到 wechat-reply');

  supervisor.handleWorkerMessage('wechat-reply', {
    type: 'bus.publish',
    topic: 'qianfan.send.request',
    payload: { replyId: 1001, replyText: 'hello', fromWxid: 'wxid_test' },
    meta: { traceId: 'trace-reply-001' },
  });

  assert(lastSent(senderRunner, 'qianfan.send.request').length > 0, 'qianfan.send.request 应路由到 qianfan-sender');
  assert(
    lastSent(senderRunner, 'qianfan.send.request')[0]?.meta?.traceId === 'trace-reply-001',
    'qianfan.send.request 必须保留 traceId',
  );

  supervisor.dispose();

  if (errors.length) {
    console.error('[check-message-bus-routing] FAILED');
    for (const err of errors) console.error(`- ${err}`);
    process.exit(1);
  }

  console.log('[check-message-bus-routing] OK');
}

main().catch((err) => {
  console.error('[check-message-bus-routing] FAILED');
  console.error(err.message || err);
  process.exit(1);
});
