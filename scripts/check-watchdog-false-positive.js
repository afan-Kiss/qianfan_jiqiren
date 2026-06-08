const { Watchdog } = require('../src/runtime/watchdog');
const { RuntimeSupervisor } = require('../src/runtime/supervisor');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

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

  watchdog.register('long-task-worker');
  watchdog.start();

  // 模拟长任务期间 heartbeat 仍持续上报
  for (let i = 0; i < 8; i += 1) {
    await sleep(400);
    watchdog.beat('long-task-worker');
  }

  if (timeoutCount !== 0) {
    throw new Error('长任务期间 heartbeat 正常时不应 timeout');
  }

  // 模拟 heartbeat 停止后才 timeout
  await sleep(2500);
  if (timeoutCount === 0) {
    throw new Error('heartbeat 停止后应触发 timeout');
  }

  let restartScheduled = false;
  const supervisor = new RuntimeSupervisor({ rootDir: ROOT });
  supervisor.scheduleWorkerRestart = () => {
    restartScheduled = true;
  };

  supervisor.handleWatchdogTimeout({
    workerName: 'long-task-worker',
    lastBeatAt: Date.now() - 5000,
    timeoutMs: 2000,
  });

  if (!restartScheduled) throw new Error('timeout 后 supervisor 应调度重启');

  watchdog.stop();
  supervisor.dispose();

  console.log('[check-watchdog-false-positive] OK');
}

main().catch((err) => {
  console.error('[check-watchdog-false-positive] FAILED');
  console.error(err.message || err);
  process.exit(1);
});
