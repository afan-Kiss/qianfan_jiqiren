const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { RuntimeSupervisor } = require('../src/runtime/supervisor');
const {
  computeRuntimeHealth,
  computeWatchdogHealth,
  buildHealthTransitionLogs,
  isRoutineHealthActivityMessage,
} = require('../src/shared/runtime-health');
const { formatActivityLogEntry } = require('../src/shared/activity-log');
const { runCheckScript } = require('./test-utils/cleanup-runtime');

function baseSnapshot(overrides = {}) {
  return {
    supervisorStatus: 'running',
    qianfanReady: true,
    listenerReady: true,
    wechatReady: true,
    lastWatchdogFeedAt: Date.now() - 10000,
    workers: [
      {
        workerName: 'qianfan-listener',
        status: 'running',
        workerAlive: true,
        qianfanReady: true,
        listenerReady: true,
        phase: 'running',
        lastStatusAt: Date.now(),
        lastHeartbeatAt: Date.now(),
      },
      {
        workerName: 'wechat-callback',
        status: 'running',
        workerAlive: true,
        businessReady: true,
        lastHeartbeatAt: Date.now(),
      },
      {
        workerName: 'wechat-notifier',
        status: 'running',
        workerAlive: true,
        lastHeartbeatAt: Date.now(),
      },
    ],
    ...overrides,
  };
}

async function main() {
  const now = Date.now();

  let health = computeRuntimeHealth(baseSnapshot(), { notifyAccountCount: 1, now });
  assert.strictEqual(health.qianfanStatus, 'normal');
  assert.strictEqual(health.wechatStatus, 'normal');
  assert.strictEqual(health.relayStatus, 'normal');
  assert.strictEqual(health.watchdogStatus, 'normal');
  assert.strictEqual(health.overall.overallStatus, 'normal');
  assert.strictEqual(health.progressLines.length, 4);

  health = computeRuntimeHealth(baseSnapshot({
    qianfanReady: false,
    listenerReady: false,
    workers: [
      {
        workerName: 'qianfan-listener',
        status: 'degraded',
        workerAlive: true,
        qianfanReady: true,
        listenerReady: false,
        phase: 'waiting_shops',
        lastError: '',
      },
      { workerName: 'wechat-callback', status: 'running', lastHeartbeatAt: now },
      { workerName: 'wechat-notifier', status: 'running', lastHeartbeatAt: now },
    ],
  }), { notifyAccountCount: 1, now });
  assert.strictEqual(health.qianfanStatus, 'warning');

  health = computeRuntimeHealth(baseSnapshot({
    qianfanReady: false,
    listenerReady: false,
    workers: [
      {
        workerName: 'qianfan-listener',
        status: 'failed',
        workerAlive: true,
        phase: 'failed',
        lastError: 'CDP 未连接',
      },
      { workerName: 'wechat-callback', status: 'running', lastHeartbeatAt: now },
      { workerName: 'wechat-notifier', status: 'running', lastHeartbeatAt: now },
    ],
  }), { notifyAccountCount: 1, now });
  assert.strictEqual(health.qianfanStatus, 'error');

  health = computeRuntimeHealth(baseSnapshot({
    wechatReady: false,
    workers: [
      { workerName: 'qianfan-listener', status: 'running', qianfanReady: true, listenerReady: true, phase: 'running', lastHeartbeatAt: now },
      { workerName: 'wechat-callback', status: 'failed', lastHeartbeatAt: now },
      { workerName: 'wechat-notifier', status: 'failed', lastHeartbeatAt: now },
    ],
  }), { notifyAccountCount: 1, now });
  assert.strictEqual(health.wechatStatus, 'error');

  health = computeRuntimeHealth(baseSnapshot({ supervisorStatus: 'degraded' }), { notifyAccountCount: 1, now });
  assert.strictEqual(health.relayStatus, 'warning');

  assert.strictEqual(computeWatchdogHealth(now - 10000, now).watchdogStatus, 'normal');
  assert.strictEqual(computeWatchdogHealth(now - 18000, now).watchdogStatus, 'delayed');
  assert.strictEqual(computeWatchdogHealth(now - 30000, now).watchdogStatus, 'timeout');
  assert.strictEqual(computeWatchdogHealth(null, now).watchdogStatus, 'unknown');

  const prev = computeRuntimeHealth(baseSnapshot(), { notifyAccountCount: 1, now });
  const next = computeRuntimeHealth(baseSnapshot({
    lastWatchdogFeedAt: now - 20000,
    workers: baseSnapshot().workers.map((worker) => ({
      ...worker,
      lastHeartbeatAt: now - 20000,
    })),
  }), { notifyAccountCount: 1, now });
  const transitions = buildHealthTransitionLogs(prev, next);
  assert.ok(transitions.some((item) => /worker/.test(item.message)));

  const recovered = computeRuntimeHealth(baseSnapshot(), { notifyAccountCount: 1, now });
  const recoveryLogs = buildHealthTransitionLogs(next, recovered);
  assert.ok(recoveryLogs.some((item) => /恢复正常/.test(item.message)));

  assert.strictEqual(formatActivityLogEntry({ userFacing: true, message: '看门狗已喂食：xxx' }).show, false);
  assert.strictEqual(formatActivityLogEntry({ userFacing: true, message: '看门狗正常运行，最近喂狗：19:20:00' }).show, true);
  assert.strictEqual(isRoutineHealthActivityMessage('worker heartbeat ok'), true);
  assert.strictEqual(isRoutineHealthActivityMessage('看门狗正常运行，最近喂狗：19:20:00'), false);

  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert.match(appSource, /buildWorkerProgressLine/);
  assert.match(appSource, /isRoutineHealthActivity/);
  assert.doesNotMatch(appSource, /setInterval\([\s\S]*lastWatchdogFeedAt\s*=\s*Date\.now/);

  const supervisorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtime', 'supervisor.js'), 'utf8');
  assert.match(supervisorSource, /maybeEmitStatusThrottled/);
  assert.match(supervisorSource, /maybeEmitStatusThrottled\(\)/);
  assert.match(supervisorSource, /看门狗正常运行，最近喂狗：/);
  assert.doesNotMatch(supervisorSource, /userLog\(`看门狗已喂食/);
  const summaryTimerBlock = supervisorSource.slice(
    supervisorSource.indexOf('startHeartbeatSummaryTimer()'),
    supervisorSource.indexOf('startHeartbeatSummaryTimer()') + 900,
  );
  assert.doesNotMatch(summaryTimerBlock, /emitStatus\(\)/, '4h summary timer must not emit status');
  assert.match(summaryTimerBlock, /看门狗正常运行，最近喂狗：/);

  const runId = crypto.randomBytes(4).toString('hex');
  const testDataDir = path.join(__dirname, '..', 'data', 'test-runtime', `homepage-health-${runId}`);
  const logsDir = path.join(testDataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const supervisor = new RuntimeSupervisor({
    rootDir: path.join(__dirname, '..'),
    logsDir,
    simEnv: { QIANFAN_SIM_MODE: '1', QIANFAN_SIM_DATA_DIR: testDataDir },
    startWorkerDelayMs: 10,
    watchdog: { heartbeatIntervalMs: 200, heartbeatTimeoutMs: 2000, checkIntervalMs: 200 },
  });
  supervisor.setNotifyAccountCount(1);
  supervisor.lastWatchdogFeedAt = now - 10000;
  supervisor.state.setSupervisorStatus('running');
  supervisor.state.setWorkerStatus('qianfan-listener', {
    status: 'running',
    workerAlive: true,
    qianfanReady: true,
    listenerReady: true,
    phase: 'running',
    lastHeartbeatAt: now,
  });
  supervisor.state.setWorkerStatus('wechat-callback', { status: 'running', lastHeartbeatAt: now });
  supervisor.state.setWorkerStatus('wechat-notifier', { status: 'running', lastHeartbeatAt: now });

  const status = supervisor.getStatus();
  assert.ok(status.health);
  assert.strictEqual(status.health.overall.overallStatus, 'normal');
  assert.strictEqual(status.lastWatchdogFeedAt, supervisor.lastWatchdogFeedAt);

  let userLogs = [];
  supervisor.on('log', (entry) => {
    if (entry.userFacing) userLogs.push(entry.message);
  });
  supervisor.emitStatus();
  supervisor.emitStatus();
  assert.strictEqual(userLogs.filter((msg) => /看门狗已喂食/.test(msg)).length, 0);

  let statusPushCount = 0;
  supervisor.removeAllListeners('status');
  supervisor.on('status', () => { statusPushCount += 1; });
  const feedBefore = supervisor.lastWatchdogFeedAt;
  supervisor.handleWorkerMessage('qianfan-listener', {
    type: 'worker.heartbeat',
    workerName: 'qianfan-listener',
    time: Date.now(),
  });
  assert.ok(supervisor.lastWatchdogFeedAt >= feedBefore, 'heartbeat must refresh lastWatchdogFeedAt');
  assert.ok(statusPushCount >= 1, 'worker heartbeat must push runtime status');
  const pushed = supervisor.getStatus();
  assert.ok(pushed.lastWorkerHeartbeatAt, 'status must expose lastWorkerHeartbeatAt');

  fs.rmSync(testDataDir, { recursive: true, force: true });
  console.log('[check-homepage-health-status] passed');
}

runCheckScript(main, { label: 'check-homepage-health-status', timeoutMs: 30000 });
