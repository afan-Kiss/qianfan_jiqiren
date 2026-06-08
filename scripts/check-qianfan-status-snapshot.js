const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { RuntimeSupervisor } = require('../src/runtime/supervisor');
const { runCheckScript } = require('./test-utils/cleanup-runtime');

async function main() {
  const runId = crypto.randomBytes(4).toString('hex');
  const testDataDir = path.join(__dirname, '..', 'data', 'test-runtime', `qianfan-status-${runId}`);
  const logsDir = path.join(testDataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const supervisor = new RuntimeSupervisor({
    rootDir: path.join(__dirname, '..'),
    logsDir,
    simEnv: { QIANFAN_SIM_MODE: '1', QIANFAN_SIM_DATA_DIR: testDataDir },
    startWorkerDelayMs: 10,
    watchdog: { heartbeatIntervalMs: 200, heartbeatTimeoutMs: 2000, checkIntervalMs: 200 },
  });

  supervisor.state.setWorkerStatus('qianfan-listener', {
    status: 'running',
    workerAlive: true,
    qianfanReady: false,
    listenerReady: false,
    phase: 'degraded',
    lastError: '千帆未接入，无法启动监听',
  });
  supervisor.state.setWorkerStatus('wechat-callback', { status: 'running' });
  supervisor.state.setSupervisorStatus('running');

  let snapshot = supervisor.getStatus();
  assert.strictEqual(snapshot.supervisorStatus, 'degraded');
  assert.strictEqual(snapshot.qianfanReady, false);
  assert.strictEqual(snapshot.listenerReady, false);

  const mapFn = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc-bridge.js'), 'utf8');
  assert.ok(mapFn.includes('listener.qianfanReady === true && listener.listenerReady === true'));

  supervisor.state.setWorkerStatus('qianfan-listener', {
    status: 'running',
    workerAlive: true,
    qianfanReady: true,
    listenerReady: true,
    phase: 'running',
    lastError: '',
    qianfanRuntime: { phase: 'ready', lastError: '' },
  });
  snapshot = supervisor.getStatus();
  assert.strictEqual(snapshot.qianfanReady, true);
  assert.strictEqual(snapshot.listenerReady, true);
  assert.strictEqual(snapshot.qianfanRuntime.phase, 'ready');

  supervisor.state.setWorkerStatus('qianfan-listener', {
    status: 'failed',
    workerAlive: true,
    qianfanReady: false,
    listenerReady: false,
    phase: 'failed',
    lastError: '未找到千帆客服工作台',
    qianfanRuntime: { phase: 'failed', lastError: '未找到千帆客服工作台' },
  });
  snapshot = supervisor.getStatus();
  const listener = snapshot.workers.find((w) => w.workerName === 'qianfan-listener');
  assert.strictEqual(listener.lastError, '未找到千帆客服工作台');
  assert.strictEqual(listener.qianfanRuntime.lastError, '未找到千帆客服工作台');

  fs.rmSync(testDataDir, { recursive: true, force: true });
  console.log('[check-qianfan-status-snapshot] passed');
}

runCheckScript(main, { label: 'check-qianfan-status-snapshot', timeoutMs: 15000 });
