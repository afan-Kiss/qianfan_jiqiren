const { createWorkerRuntime } = require('../../src/workers/worker-bootstrap');

const runtime = createWorkerRuntime({ workerName: 'long-task-worker' });

setTimeout(() => {
  runtime.log('info', 'long task still running');
}, 10000);
