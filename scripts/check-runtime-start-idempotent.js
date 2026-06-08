const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { RuntimeSupervisor } = require('../src/runtime/supervisor');
const { START_ORDER } = require('../src/runtime/worker-registry');
const { runCheckScript } = require('./test-utils/cleanup-runtime');
const { collectSupervisorPids } = require('./test-utils/cleanup-runtime');

async function main() {
  const runId = crypto.randomBytes(4).toString('hex');
  const testDataDir = path.join(__dirname, '..', 'data', 'test-runtime', `start-idem-${runId}`);
  const logsDir = path.join(testDataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const supervisor = new RuntimeSupervisor({
    rootDir: path.join(__dirname, '..'),
    logsDir,
    simEnv: { QIANFAN_SIM_MODE: '1', QIANFAN_SIM_DATA_DIR: testDataDir },
    startWorkerDelayMs: 20,
    watchdog: { heartbeatIntervalMs: 200, heartbeatTimeoutMs: 2000, checkIntervalMs: 200 },
  });

  let logCount = 0;
  supervisor.on('log', () => { logCount += 1; });

  const [s1, s2, s3] = await Promise.all([
    supervisor.startAll(),
    supervisor.startAll(),
    supervisor.startAll(),
  ]);

  assert.strictEqual(s1.supervisorStatus, s2.supervisorStatus);
  assert.strictEqual(s2.supervisorStatus, s3.supervisorStatus);

  for (const workerName of START_ORDER) {
    const runners = [...supervisor.runners.values()].filter((r) => r.workerName === workerName);
    assert.strictEqual(runners.length, 1, `duplicate runner for ${workerName}`);
  }

  const listenerWorkers = supervisor.getStatus().workers.filter((w) => w.workerName === 'qianfan-listener');
  assert.strictEqual(listenerWorkers.length, 1);

  const pidsBefore = collectSupervisorPids(supervisor);
  await supervisor.startAll();
  const pidsAfter = collectSupervisorPids(supervisor);
  assert.deepStrictEqual(pidsBefore.sort(), pidsAfter.sort());

  await supervisor.stopAll('test');
  const afterStop = supervisor.getStatus();
  assert.ok(afterStop.workers.every((w) => w.status === 'stopped' || !w.pid));

  fs.rmSync(testDataDir, { recursive: true, force: true });
  console.log('[check-runtime-start-idempotent] passed');
}

runCheckScript(main, { label: 'check-runtime-start-idempotent', timeoutMs: 60000 });
