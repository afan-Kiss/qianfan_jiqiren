const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { fork } = require('child_process');
const { WorkerRunner, FORK_RETRY_DELAYS } = require('../src/runtime/worker-runner');
const { getWorkerEntries } = require('../src/runtime/worker-registry');
const { runCheckScript } = require('./test-utils/cleanup-runtime');
const { dumpActiveHandles } = require('./test-utils/dump-active-handles');

const ROOT = path.resolve(__dirname, '..');

function createTestLogger() {
  const entries = [];
  return {
    entries,
    write(entry) {
      entries.push(entry);
      return entry;
    },
  };
}

function buildRunner(options = {}) {
  const runId = options.runId || crypto.randomBytes(4).toString('hex');
  const testDataDir = path.join(ROOT, 'data', 'test-runtime', `retry-${runId}`);
  fs.mkdirSync(testDataDir, { recursive: true });
  const entries = getWorkerEntries(ROOT);
  const logger = createTestLogger();
  const runner = new WorkerRunner({
    workerName: 'persistence',
    workerEntry: entries.persistence,
    rootDir: ROOT,
    logger,
    extraEnv: {
      QIANFAN_SIM_MODE: '1',
      QIANFAN_SIM_DATA_DIR: testDataDir,
    },
    forkFn: options.forkFn,
  });
  return { runner, logger, testDataDir };
}

function makeForkError(code, message) {
  const err = new Error(message || `spawn ${code}`);
  err.code = code;
  return err;
}

async function testRetrySuccess() {
  let calls = 0;
  const { runner, logger, testDataDir } = buildRunner({
    forkFn: (...args) => {
      calls += 1;
      if (calls === 1) {
        throw makeForkError('EPERM');
      }
      return fork(...args);
    },
  });

  try {
    const result = await runner.start();
    assert.strictEqual(result.ok, true, 'second fork attempt should succeed');
    assert.strictEqual(calls, 2, 'should retry once after EPERM');
    assert.ok(runner.pid, 'worker should have pid');
    assert.ok(
      logger.entries.some((entry) => String(entry.message || '').includes('fork retry 1/')),
      'retry should be logged',
    );

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.strictEqual(runner.getStatus().status, 'starting', 'worker stays starting until ready message');
  } finally {
    await runner.stop();
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
}

async function testNonRetryableFailsFast() {
  let calls = 0;
  const { runner, testDataDir } = buildRunner({
    forkFn: () => {
      calls += 1;
      throw makeForkError('ENOENT', 'script not found');
    },
  });

  try {
    const result = await runner.start();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(calls, 1, 'non-retryable error must not retry');
    assert.strictEqual(runner.status, 'failed');
  } finally {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
}

async function testMaxRetriesFailed() {
  let calls = 0;
  const { runner, logger, testDataDir } = buildRunner({
    forkFn: () => {
      calls += 1;
      throw makeForkError('EBUSY');
    },
  });

  try {
    const result = await runner.start();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(calls, FORK_RETRY_DELAYS.length + 1, 'should attempt initial + 3 retries');
    assert.strictEqual(runner.status, 'failed');
    assert.ok(
      logger.entries.filter((entry) => String(entry.message || '').includes('fork retry')).length
        === FORK_RETRY_DELAYS.length,
      'each retry should be logged',
    );
  } finally {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
}

async function main() {
  try {
    await testRetrySuccess();
    await testNonRetryableFailsFast();
    await testMaxRetriesFailed();
    console.log('[check-worker-start-retry] passed');
  } catch (err) {
    dumpActiveHandles('check-worker-start-retry active handles');
    throw err;
  }
}

runCheckScript(main, { label: 'check-worker-start-retry', timeoutMs: 30000 });
