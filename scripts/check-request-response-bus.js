const path = require('path');
const { RuntimeSupervisor } = require('../src/runtime/supervisor');
const { handlePersistRequest } = require('../src/adapters/legacy-data-store-adapter');

const ROOT = path.resolve(__dirname, '..');

function createMockRunner(workerName) {
  return {
    workerName,
    sent: [],
    pid: 1000 + workerName.length,
    send(message) {
      this.sent.push(message);
      return true;
    },
    getStatus() {
      return { workerName, status: 'running', pid: this.pid };
    },
  };
}

async function main() {
  const supervisor = new RuntimeSupervisor({ rootDir: ROOT });
  supervisor.registerDefaultWorkers();

  const persistenceRunner = createMockRunner('persistence');
  const requesterRunner = createMockRunner('qianfan-listener');
  supervisor.runners.set('persistence', persistenceRunner);
  supervisor.runners.set('qianfan-listener', requesterRunner);

  const requestId = 'req-test-001';
  const traceId = 'trace-rpc-001';
  const payload = {
    action: 'sessionContext.get',
    data: { shopTitle: 'rpc-shop', appCid: 'rpc-cid' },
    idempotencyKey: 'rpc-test-key',
    traceId,
    sourceWorker: 'qianfan-listener',
    createdAt: Date.now(),
  };

  supervisor.handleWorkerMessage('qianfan-listener', {
    type: 'bus.publish',
    topic: 'task.persist.request',
    payload,
    meta: { traceId, requestId, replyTo: 'qianfan-listener', from: 'qianfan-listener' },
  });

  const persistMsg = persistenceRunner.sent.find((m) => m.type === 'bus.message' && m.topic === 'task.persist.request');
  if (!persistMsg) throw new Error('persistence worker did not receive task.persist.request');
  if (persistMsg.meta.requestId !== requestId) throw new Error('requestId not forwarded to persistence');

  const result = await handlePersistRequest(persistMsg.payload);
  supervisor.forwardBusMessage({
    topic: 'task.persist.result',
    payload: {
      action: payload.action,
      ok: result.ok,
      data: result.data,
      error: result.error,
      idempotencyKey: payload.idempotencyKey,
      traceId,
    },
    meta: { traceId, requestId, replyTo: 'qianfan-listener', from: 'persistence' },
  });

  const replyMsg = requesterRunner.sent.find(
    (m) => m.type === 'bus.message' && m.topic === 'task.persist.result',
  );
  if (!replyMsg) throw new Error('requester worker did not receive task.persist.result');
  if (replyMsg.meta.requestId !== requestId) throw new Error('requestId missing on task.persist.result');
  if (replyMsg.payload.ok !== true) throw new Error('persist result should be ok=true');

  supervisor.dispose();
  console.log('[check-request-response-bus] OK');
}

main().catch((err) => {
  console.error('[check-request-response-bus] FAILED');
  console.error(err.message || err);
  process.exit(1);
});
