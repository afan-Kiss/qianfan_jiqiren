const assert = require('assert');
const path = require('path');
const { createQianfanRuntimeController } = require('../src/adapters/qianfan-runtime-controller');
const { runCheckScript } = require('./test-utils/cleanup-runtime');

const SHOP_PAGE = {
  type: 'page',
  webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/1',
  title: '测试店-工作台',
  url: 'https://walle.xiaohongshu.com/cstools/seller/dashboard',
};

function installFetchMock(mode = 'attached') {
  const originalFetch = global.fetch;
  let launchPhase = 0;
  global.fetch = async (url) => {
    const text = String(url);
    if (mode === 'unreachable') {
      throw new Error('fetch failed ECONNREFUSED');
    }
    if (mode === 'launch') {
      if (text.includes('/json/version')) {
        launchPhase += 1;
        if (launchPhase < 2) throw new Error('fetch failed ECONNREFUSED');
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
  delete process.env.QIANFAN_SIM_MODE;

  const baseConfig = {
    devtoolsPort: 19223,
    devtoolsHost: '127.0.0.1',
    autoLaunchQianfanClientWhenMissing: true,
    qianfanClientExePath: path.join(__dirname, 'fixtures', 'fake-qianfan.exe'),
    qianfanClientWorkingDir: __dirname,
    expectedShopCount: 1,
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
  assert.strictEqual(degraded.phase, 'degraded');
  restoreDegraded();

  let launchCount = 0;
  const restoreLaunch = installFetchMock('launch');
  const launchController = createQianfanRuntimeController({
    config: baseConfig,
    existsFn: () => true,
    launchClientFn: async () => {
      launchCount += 1;
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
  const restoreConcurrent = installFetchMock('launch');
  const concurrentController = createQianfanRuntimeController({
    config: baseConfig,
    existsFn: () => true,
    launchClientFn: async () => {
      launchCount += 1;
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
  assert.notStrictEqual(emptyAttached.phase, 'attached', 'non-qianfan devtools must not attach as ready');
  if (emptyAttached.phase === 'ready') {
    assert.ok(emptyPageLaunchCount >= 1, 'qianfan process without pages should relaunch in debug mode');
  } else {
    assert.strictEqual(emptyAttached.phase, 'failed');
    assert.ok(
      /占用|千帆页面|devtoolsPort/i.test(String(emptyAttached.lastError || '')),
      `unexpected lastError: ${emptyAttached.lastError}`,
    );
    assert.strictEqual(emptyPageLaunchCount, 0, 'foreign devtools port must not relaunch qianfan');
  }
  restoreEmptyPages();

  process.env.QIANFAN_SIM_MODE = '1';
  const simController = createQianfanRuntimeController({ config: baseConfig });
  const simReady = await simController.ensureQianfanReady();
  assert.strictEqual(simReady.phase, 'ready');
  assert.strictEqual(simReady.sim, true);

  if (originalSim) process.env.QIANFAN_SIM_MODE = originalSim;
  else delete process.env.QIANFAN_SIM_MODE;

  console.log('[check-qianfan-runtime-controller] passed');
}

runCheckScript(main, { label: 'check-qianfan-runtime-controller', timeoutMs: 45000 });
