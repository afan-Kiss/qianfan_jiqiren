const { createWorkerRuntime } = require('../../src/workers/worker-bootstrap');

const runtime = createWorkerRuntime({ workerName: 'fake-worker' });
runtime.log('info', 'fake worker started');
