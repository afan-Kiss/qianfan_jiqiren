const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { RuntimeSupervisor } = require('../src/runtime/supervisor');
const { WECHAT_BOOT_ORDER } = require('../src/runtime/worker-registry');
const { runCheckScript } = require('./test-utils/cleanup-runtime');

async function main() {
  const runId = crypto.randomBytes(4).toString('hex');
  const testDataDir = path.join(__dirname, '..', 'data', 'test-runtime', `deferred-wechat-${runId}`);
  const logsDir = path.join(testDataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const supervisor = new RuntimeSupervisor({
    rootDir: path.join(__dirname, '..'),
    logsDir,
    simEnv: { QIANFAN_SIM_MODE: '1', QIANFAN_SIM_DATA_DIR: testDataDir },
    startWorkerDelayMs: 10,
    watchdog: { heartbeatIntervalMs: 200, heartbeatTimeoutMs: 2000, checkIntervalMs: 200 },
  });

  supervisor.registerDefaultWorkers();
  supervisor.state.setSupervisorStatus('degraded');
  supervisor.state.setWorkerStatus('qianfan-listener', {
    status: 'degraded',
    qianfanReady: false,
    listenerReady: false,
    phase: 'waiting_shops',
    reason: '千帆已启动，店铺工作台页面还在加载',
  });

  for (const workerName of WECHAT_BOOT_ORDER) {
    const status = supervisor.getWorkerStatus(workerName);
    assert.notStrictEqual(status.status, 'running', `${workerName} should not be running before listener ready`);
  }

  supervisor.handleWorkerMessage('qianfan-listener', {
    type: 'worker.status',
    workerAlive: true,
    qianfanReady: true,
    listenerReady: true,
    phase: 'running',
    shopReport: { shops: [{ shopTitle: '测试店' }] },
    time: Date.now(),
  });

  await new Promise((resolve) => setTimeout(resolve, 500));

  for (const workerName of WECHAT_BOOT_ORDER) {
    const status = supervisor.getWorkerStatus(workerName);
    assert.strictEqual(status.status, 'running', `${workerName} should start after listener ready`);
  }

  assert.strictEqual(supervisor.wechatBootCompleted, true);

  await supervisor.stopAll('test');
  fs.rmSync(testDataDir, { recursive: true, force: true });
  console.log('[check-deferred-wechat-boot] passed');
}

runCheckScript(main, { label: 'check-deferred-wechat-boot', timeoutMs: 30000 });
