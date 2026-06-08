const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createActivityDedup, buildActivityDedupKey } = require('../src/shared/activity-dedup');
const { formatActivityLogEntry } = require('../src/shared/activity-log');
const { formatLogTime } = require('../src/shared/user-activity-log');
const { runCheckScript } = require('./test-utils/cleanup-runtime');

async function main() {
  const dedup = createActivityDedup(3000);
  const key = buildActivityDedupKey({
    workerName: 'qianfan-listener',
    level: 'info',
    message: '「千帆监听」运行正常',
    userFacing: true,
  });

  assert.strictEqual(dedup.shouldShow(key, 1000), true, 'first show');
  assert.strictEqual(dedup.shouldShow(key, 2000), false, 'duplicate within window');
  assert.strictEqual(dedup.shouldShow(key, 5000), true, 'show after window elapsed');

  const hidden = formatActivityLogEntry({
    workerName: 'wechat-reply',
    level: 'info',
    message: 'publish qianfan.send.request',
  });
  assert.strictEqual(hidden.show, false, 'non user-facing logs must be hidden');

  const watchdog = formatActivityLogEntry({
    userFacing: true,
    level: 'error',
    message: '看门狗检测到「千帆监听」心跳超时，正在重启',
  });
  assert.strictEqual(watchdog.show, true, 'watchdog message must show');
  assert.ok(watchdog.text.includes('看门狗'), 'watchdog text must stay readable');

  const startMsg = formatActivityLogEntry({
    userFacing: true,
    level: 'info',
    message: '中转服务正在启动',
  });
  assert.strictEqual(startMsg.show, true);
  assert.strictEqual(startMsg.text, '中转服务正在启动');

  const formattedTime = formatLogTime(new Date(2026, 5, 6, 14, 35, 0));
  assert.strictEqual(formattedTime, '06-06 14:35', 'activity time must use MM-DD HH:mm');

  const ipcBridge = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'ipc-bridge.js'),
    'utf8',
  );
  assert.ok(!ipcBridge.includes("safePush('relay:log-line'"), 'ipc-bridge must not duplicate relay log lines');
  assert.ok(ipcBridge.includes('formatActivityLogEntry'), 'ipc-bridge must format runtime logs');
  assert.ok(ipcBridge.includes('formatLogTime'), 'ipc-bridge must attach display time');

  const appJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert.ok(appJs.includes('unsubscribeRuntimeStatus'), 'renderer must cleanup runtime status listener');
  assert.ok(appJs.includes('unsubscribeRuntimeLog'), 'renderer must cleanup runtime log listener');
  assert.ok(!appJs.includes('onRelayLogLine((line)'), 'renderer must not subscribe relay log duplicate');
  assert.ok(appJs.includes('entry.dedupKey'), 'renderer must honor formatted dedup keys');
  assert.ok(appJs.includes('formatActivityTime'), 'renderer must format MM-DD HH:mm timestamps');

  const supervisorJs = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'runtime', 'supervisor.js'),
    'utf8',
  );
  assert.ok(supervisorJs.includes('userLog('), 'supervisor must emit user-facing logs');
  assert.ok(supervisorJs.includes('fileLog('), 'technical logs must stay in file log only');

  console.log('[check-ui-log-dedup] passed');
}

runCheckScript(main, { label: 'check-ui-log-dedup', timeoutMs: 15000 });
