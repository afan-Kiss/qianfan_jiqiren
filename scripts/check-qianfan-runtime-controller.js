const assert = require('assert');
const path = require('path');
const { createQianfanRuntimeController } = require('../src/adapters/qianfan-runtime-controller');
const qianfanLauncher = require('../src/qianfan-client-launcher');
const { runCheckScript } = require('./test-utils/cleanup-runtime');

const SHOP_PAGE = {
  type: 'page',
  webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/1',
  title: '测试店-工作台',
  url: 'https://walle.xiaohongshu.com/cstools/seller/dashboard',
};

function installFetchMock(mode = 'attached', gate = null) {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const text = String(url);
    if (mode === 'unreachable') {
      throw new Error('fetch failed ECONNREFUSED');
    }
    if (mode === 'launch') {
      if (text.includes('/json/version')) {
        if (!gate || !gate.ready) throw new Error('fetch failed ECONNREFUSED');
        return { ok: true, json: async () => ({ Browser: 'Chrome/120' }) };
      }
    }
    if (text.includes('/json/version')) {
      return { ok: true, json: async () => ({ Browser: 'Chrome/120' }) };
    }
    if (text.includes('/json/list')) {
      return { ok: true, json: async () => ([SHOP_PAGE]) };
    }
    throw new Error(`unexpected fetch ${text}`);
  };
  return () => {
    global.fetch = originalFetch;
  };
}

async function main() {
  const originalSim = process.env.QIANFAN_SIM_MODE;
  const originalProcessRunning = qianfanLauncher.isQianfanProcessRunning;
  qianfanLauncher.isQianfanProcessRunning = () => false;
  delete process.env.QIANFAN_SIM_MODE;

  const baseConfig = {
    devtoolsPort: 19223,
    devtoolsHost: '127.0.0.1',
    autoLaunchQianfanClientWhenMissing: true,
    qianfanClientExePath: path.join(__dirname, 'fixtures', 'fake-qianfan.exe'),
    qianfanClientWorkingDir: __dirname,
    expectedShopCount: 1,
    waitTimeoutMs: 5000,
    checkIntervalMs: 200,
  };

  const restoreAttached = installFetchMock('attached');
  const attachController = createQianfanRuntimeController({
    config: baseConfig,
    existsFn: () => true,
  });
  const attached = await attachController.ensureQianfanReady();
  assert.strictEqual(attached.phase, 'attached');
  assert.strictEqual(attachController.getStatus().phase, 'attached');
  restoreAttached();

  const restoreMissing = installFetchMock('unreachable');
  const missingExeController = createQianfanRuntimeController({
    config: { ...baseConfig, qianfanClientExePath: 'Z:\\missing\\qianfan.exe' },
    existsFn: () => false,
    spawnFn: () => {
      throw new Error('should not launch');
    },
  });
  const missing = await missingExeController.ensureQianfanReady();
  assert.strictEqual(missing.phase, 'failed');
  restoreMissing();

  const restoreDegraded = installFetchMock('unreachable');
  const degradedController = createQianfanRuntimeController({
    config: { ...baseConfig, autoLaunchQianfanClientWhenMissing: false },
    existsFn: () => true,
  });
  const degraded = await degradedController.ensureQianfanReady();
  assert.strictEqual(degraded.phase, 'waiting_launch');
  restoreDegraded();

  let launchCount = 0;
  const launchGate = { ready: false };
  const restoreLaunch = installFetchMock('launch', launchGate);
  const launchController = createQianfanRuntimeController({
    config: baseConfig,
    existsFn: () => true,
    launchClientFn: async () => {
      launchCount += 1;
      launchGate.ready = true;
      return { ok: true, pid: 5678, processStarted: true };
    },
  });
  const launched = await launchController.ensureQianfanReady();
  assert.strictEqual(launched.phase, 'ready');
  assert.strictEqual(launchCount, 1);
  restoreLaunch();

  const restoreFailLaunch = installFetchMock('unreachable');
  const failLaunchController = createQianfanRuntimeController({
    config: baseConfig,
    existsFn: () => true,
    launchClientFn: async () => ({ ok: false, error: 'spawn failed' }),
  });
  const failed = await failLaunchController.ensureQianfanReady();
  assert.strictEqual(failed.phase, 'failed');
  restoreFailLaunch();

  launchCount = 0;
  const concurrentGate = { ready: false };
  const restoreConcurrent = installFetchMock('launch', concurrentGate);
  const concurrentController = createQianfanRuntimeController({
    config: baseConfig,
    existsFn: () => true,
    launchClientFn: async () => {
      launchCount += 1;
      concurrentGate.ready = true;
      return { ok: true, pid: 9999, processStarted: true };
    },
  });
  await Promise.all([
    concurrentController.ensureQianfanReady(),
    concurrentController.ensureQianfanReady(),
    concurrentController.ensureQianfanReady(),
  ]);
  assert.strictEqual(launchCount, 1);
  restoreConcurrent();

  const restoreEmptyPages = installFetchMock('launch');
  global.fetch = async (url) => {
    const text = String(url);
    if (text.includes('/json/version')) {
      return { ok: true, json: async () => ({ Browser: 'Chrome/120' }) };
    }
    if (text.includes('/json/list')) {
      return { ok: true, json: async () => ([]) };
    }
    throw new Error(`unexpected fetch ${text}`);
  };
  let emptyPageLaunchCount = 0;
  const emptyPageController = createQianfanRuntimeController({
    config: baseConfig,
    existsFn: () => true,
    launchClientFn: async () => {
      emptyPageLaunchCount += 1;
      return { ok: true, pid: 4321, processStarted: true };
    },
  });
  const emptyAttached = await emptyPageController.ensureQianfanReady();
  assert.strictEqual(emptyAttached.phase, 'attached');
  assert.strictEqual(emptyAttached.ok, true);
  assert.strictEqual(emptyPageLaunchCount, 0, 'devtools ready must not relaunch qianfan when only shop pages are missing');
  restoreEmptyPages();

  const fs = require('fs');
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
  assert.match(preloadSource, /startRelay:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('app:start-relay'\)/);
  assert.match(preloadSource, /startBot:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('app:start-bot'\)/);
  assert.doesNotMatch(preloadSource, /startRelay:[\s\S]*runtime:start/);

  const ipcBridgeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc-bridge.js'), 'utf8');
  assert.match(ipcBridgeSource, /async function startRuntimeWithQianfanPreflight\(/);
  assert.match(ipcBridgeSource, /ipcMain\.handle\('runtime:start', async \(\) => startRuntimeWithQianfanPreflight\(\)\)/);
  assert.match(ipcBridgeSource, /ipcMain\.handle\('app:start-relay', async \(\) => startRuntimeWithQianfanPreflight\(\)\)/);
  assert.match(ipcBridgeSource, /ipcMain\.handle\('app:start-bot', async \(\) => startRuntimeWithQianfanPreflight\(\)\)/);

  process.env.QIANFAN_SIM_MODE = '1';
  const simController = createQianfanRuntimeController({ config: baseConfig });
  const simReady = await simController.ensureQianfanReady();
  assert.strictEqual(simReady.phase, 'ready');
  assert.strictEqual(simReady.sim, true);

  if (originalSim) process.env.QIANFAN_SIM_MODE = originalSim;
  else delete process.env.QIANFAN_SIM_MODE;
  qianfanLauncher.isQianfanProcessRunning = originalProcessRunning;

  console.log('[check-qianfan-runtime-controller] passed');
}

runCheckScript(main, { label: 'check-qianfan-runtime-controller', timeoutMs: 45000 });
