const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runCheckScript } = require('./test-utils/cleanup-runtime');
const qianfanLauncher = require('../src/qianfan-client-launcher');

async function main() {
  const launcherSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'qianfan-client-launcher.js'),
    'utf8',
  );
  const cleanupSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'shared', 'runtime-process-cleanup.js'),
    'utf8',
  );
  const workerSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'workers', 'qianfan-listener.worker.js'),
    'utf8',
  );
  const workerBootstrapSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'workers', 'worker-bootstrap.js'),
    'utf8',
  );
  const controllerSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'adapters', 'qianfan-runtime-controller.js'),
    'utf8',
  );
  const ipcSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'ipc-bridge.js'),
    'utf8',
  );

  assert.match(launcherSource, /killQianfanClientIfNotInDebugMode/);
  assert.match(launcherSource, /千帆已在调试模式运行，不会结束进程/);
  assert.match(launcherSource, /ensureQianfanDevToolsReady[\s\S]*killQianfanClientIfNotInDebugMode/);
  assert.doesNotMatch(cleanupSource, /killExistingQianfanClient/);
  assert.match(cleanupSource, /killQianfan:\s*false/);
  assert.match(cleanupSource, /退出软件时不结束千帆/);
  assert.doesNotMatch(workerSource, /killExistingQianfanClient/);
  assert.doesNotMatch(workerSource, /stopOwnedQianfan/);
  assert.doesNotMatch(controllerSource, /process\.kill\(ownedPid\)/);
  assert.match(launcherSource, /allowKill !== true/);
  assert.match(launcherSource, /isRuntimeShuttingDown/);
  assert.match(ipcSource, /QIANFAN_RUNTIME_SHUTTING_DOWN/);
  assert.match(workerBootstrapSource, /QIANFAN_RUNTIME_SHUTTING_DOWN/);
  assert.match(workerSource, /isRuntimeShuttingDown/);
  assert.match(workerSource, /ensureListenerCleanupRegistered/);

  assert.match(ipcSource, /stopRuntimeChildProcesses/);

  process.env.QIANFAN_RUNTIME_SHUTTING_DOWN = '1';
  try {
    const blocked = await qianfanLauncher.killQianfanClientIfNotInDebugMode(
      {
        devtoolsPort: 19227,
        qianfanClientProcessName: '千帆客服工作台.exe',
      },
      { allowKill: true },
    );
    assert.strictEqual(blocked.killed, false);
    assert.strictEqual(blocked.reason, 'runtime_shutting_down');
  } finally {
    delete process.env.QIANFAN_RUNTIME_SHUTTING_DOWN;
  }

  const blockedWithoutAllow = await qianfanLauncher.killQianfanClientIfNotInDebugMode({
    devtoolsPort: 19224,
    qianfanClientProcessName: 'non-existent-qianfan-process-xyz.exe',
  });
  assert.strictEqual(blockedWithoutAllow.killed, false);
  assert.strictEqual(blockedWithoutAllow.reason, 'kill_not_allowed');

  const notRunning = await qianfanLauncher.killQianfanClientIfNotInDebugMode(
    {
      devtoolsPort: 19224,
      qianfanClientProcessName: 'non-existent-qianfan-process-xyz.exe',
    },
    { allowKill: true },
  );
  assert.strictEqual(notRunning.killed, false);
  assert.strictEqual(notRunning.reason, 'not_running');

  console.log('[check-qianfan-kill-policy] passed');
}

runCheckScript(main, { label: 'check-qianfan-kill-policy', timeoutMs: 30000 });
