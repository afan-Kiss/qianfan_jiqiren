const path = require('path');
const { fork } = require('child_process');
const { RuntimeSupervisor } = require('../src/runtime/supervisor');
const { Watchdog } = require('../src/runtime/watchdog');
const { RestartPolicy } = require('../src/runtime/restart-policy');

const ROOT = path.resolve(__dirname, '..');
const FAKE_WORKER = path.join(ROOT, 'scripts', 'fixtures', 'fake-worker.js');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const watchdog = new Watchdog({
    heartbeatIntervalMs: 5000,
    heartbeatTimeoutMs: 2000,
    checkIntervalMs: 500,
  });

  let timeoutCount = 0;
  watchdog.on('timeout', () => {
    timeoutCount += 1;
  });

  watchdog.register('fake-worker');
  watchdog.beat('fake-worker');
  watchdog.start();
  await sleep(1200);
  if (timeoutCount !== 0) throw new Error('正常 heartbeat 时不应 timeout');

  await sleep(2500);
  if (timeoutCount === 0) throw new Error('停止 heartbeat 后应 timeout');
  watchdog.stop();

  const policy = new RestartPolicy({ maxRestartsInWindow: 2, windowMs: 10000 });
  policy.recordRestart('fake-worker');
  policy.recordRestart('fake-worker');
  if (policy.canRestart('fake-worker')) throw new Error('超过窗口次数后应熔断');
  policy.reset('fake-worker');
  if (!policy.canRestart('fake-worker')) throw new Error('手动 reset 后应允许重启');

  const supervisor = new RuntimeSupervisor({ rootDir: ROOT });
  supervisor.workerEntries['fake-worker'] = FAKE_WORKER;
  supervisor.registerDefaultWorkers();
  await supervisor.startWorker('fake-worker');
  await sleep(1500);
  const status = supervisor.getWorkerStatus('fake-worker');
  if (status.status !== 'running' && status.status !== 'starting') {
    throw new Error(`fake worker 应处于 running/starting，当前 ${status.status}`);
  }
  await supervisor.restartWorker('fake-worker', 'manual', { manual: true });
  await supervisor.stopWorker('fake-worker');
  supervisor.dispose();

  console.log('[check-watchdog-restart] OK');
}

main().catch((err) => {
  console.error('[check-watchdog-restart] FAILED');
  console.error(err.message || err);
  process.exit(1);
});
