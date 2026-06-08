const fs = require('fs');
const { getPageTargets } = require('../devtools-list');
const { detectQianfanShopPages, validateQianfanDevToolsProbe } = require('../page-finder');
const {
  probeDevTools,
  resolveClientConfig,
  killExistingQianfanClient,
  isQianfanProcessRunning,
  isDistributedWorkerProcess,
  closeQianfanClientIfRunning,
  launchQianfanClientAndVerify,
  waitForProcessExit,
} = require('../qianfan-client-launcher');

const DEFAULT_CLIENT_EXE = 'E:\\千帆\\eva\\千帆客服工作台.exe';
const DEFAULT_CLIENT_DIR = 'E:\\千帆\\eva';
const PORT_WAIT_MS = 60000;
const POLL_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSimMode() {
  return process.env.QIANFAN_SIM_MODE === '1';
}

function buildQianfanAttachHint(clientConfig = {}, probe = {}) {
  const port = Number(clientConfig.devtoolsPort || 9223);
  const host = clientConfig.devtoolsHost || '127.0.0.1';
  if (probe.occupied) {
    return `${port} 端口被其他程序占用，请关闭占用程序或修改 config.wxbot-new.json 里的 devtoolsPort`;
  }
  const reason = String(probe.reason || 'unreachable');
  if (reason === 'unreachable') {
    if (isQianfanProcessRunning(clientConfig.qianfanClientProcessName)) {
      return `千帆已在运行，但未开启调试端口 ${port}。软件将尝试关闭并以调试模式重新启动`;
    }
    return `千帆 DevTools ${host}:${port} 不可访问，正在尝试通过 cmd 以调试模式自动启动…`;
  }
  if (reason === 'timeout') {
    return `千帆 DevTools ${port} 等待超时，请确认千帆客服工作台已以调试模式启动`;
  }
  return `千帆 DevTools ${port} 不可用：${reason}`;
}

function resolveConfig(cfg = {}) {
  const port = Number(cfg.devtoolsPort || 9223);
  const host = cfg.devtoolsHost || '127.0.0.1';
  return {
    enabled: cfg.enabled !== false,
    devtoolsPort: port,
    devtoolsHost: host,
    autoLaunchQianfanClientWhenMissing: cfg.autoLaunchQianfanClientWhenMissing !== false,
    autoCloseExistingQianfanClient: cfg.autoCloseExistingQianfanClient !== false,
    qianfanClientExePath: String(cfg.qianfanClientExePath || DEFAULT_CLIENT_EXE).trim(),
    qianfanClientWorkingDir: String(cfg.qianfanClientWorkingDir || DEFAULT_CLIENT_DIR).trim(),
    qianfanClientProcessName: String(cfg.qianfanClientProcessName || '千帆客服工作台.exe').trim(),
    expectedShopCount: Number(cfg.expectedShopCount || 4),
    waitTimeoutMs: Number(cfg.waitTimeoutMs || PORT_WAIT_MS),
    checkIntervalMs: Number(cfg.checkIntervalMs || 2000),
    closeWaitMs: Number(cfg.closeWaitMs || 2000),
    qianfanClientArgs: Array.isArray(cfg.qianfanClientArgs) && cfg.qianfanClientArgs.length
      ? cfg.qianfanClientArgs.map((arg) =>
          String(arg).replace(/9223/g, String(port)).replace(/127\.0\.0\.1/g, host),
        )
      : [
          `--remote-debugging-port=${port}`,
          `--remote-debugging-address=${host}`,
          '--remote-allow-origins=*',
          '--disable-features=BlockInsecurePrivateNetworkRequests',
        ],
  };
}

function createQianfanRuntimeController(options = {}) {
  const existsFn = options.existsFn || fs.existsSync.bind(fs);
  const logFn = options.log || (() => {});
  const onPhase = typeof options.onPhase === 'function' ? options.onPhase : null;
  const launchClientFn = options.launchClientFn || launchQianfanClientAndVerify;
  const config = resolveConfig(options.config || options.qianfanDebug || {});

  let phase = 'idle';
  let ownedPid = null;
  let lastError = '';
  let lastReadyAt = null;
  let inFlight = null;
  let lastDevToolsList = null;

  function getStatus() {
    return {
      phase,
      exePath: config.qianfanClientExePath,
      devtoolsPort: config.devtoolsPort,
      isPortOpen: phase === 'ready' || phase === 'attached',
      isCdpReady: phase === 'ready' || phase === 'attached',
      ownedPid,
      lastError,
      lastReadyAt,
    };
  }

  function toClientConfig() {
    return resolveClientConfig({
      enabled: config.enabled,
      devtoolsPort: config.devtoolsPort,
      devtoolsHost: config.devtoolsHost,
      autoLaunchQianfanClientWhenMissing: config.autoLaunchQianfanClientWhenMissing,
      autoCloseExistingQianfanClient: config.autoCloseExistingQianfanClient,
      qianfanClientExePath: config.qianfanClientExePath,
      qianfanClientWorkingDir: config.qianfanClientWorkingDir,
      qianfanClientArgs: config.qianfanClientArgs,
      waitTimeoutMs: config.waitTimeoutMs,
      checkIntervalMs: config.checkIntervalMs,
    });
  }

  async function waitForDevToolsProbe(clientConfig, timeoutMs = clientConfig.waitTimeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const probe = await probeDevTools(clientConfig);
      if (probe.ok) return probe;
      if (probe.occupied) {
        return { ok: false, occupied: true, reason: probe.reason || 'port_occupied' };
      }
      await sleep(clientConfig.checkIntervalMs || POLL_MS);
    }
    return { ok: false, reason: 'timeout' };
  }

  function probeResultToCdp(probe) {
    const list = probe.list || [];
    const pages = getPageTargets(list);
    lastDevToolsList = list;
    return { list, pages, pageCount: pages.length };
  }

  async function checkDevToolsPort(port = config.devtoolsPort, host = config.devtoolsHost) {
    const probe = await probeDevTools({ devtoolsPort: port, devtoolsHost: host });
    if (probe.ok) return { ok: true, browser: probe.browser };
    if (probe.occupied) return { ok: false, reason: probe.reason || 'not_chrome_devtools', occupied: true };
    return { ok: false, reason: probe.reason || 'unreachable' };
  }

  async function checkCdpReady(port = config.devtoolsPort, host = config.devtoolsHost) {
    const probe = await probeDevTools({ devtoolsPort: port, devtoolsHost: host });
    if (!probe.ok) {
      return { ok: false, reason: probe.reason || 'unreachable', list: [], pages: [] };
    }
    const cdp = probeResultToCdp(probe);
    return { ok: true, pageCount: cdp.pageCount, list: cdp.list, pages: cdp.pages };
  }

  async function launchQianfanDebug(launchOptions = {}) {
    if (isSimMode()) {
      phase = 'ready';
      lastReadyAt = Date.now();
      return { ok: true, phase: 'ready', sim: true };
    }

    if (!existsFn(config.qianfanClientExePath)) {
      phase = 'failed';
      lastError = `未找到千帆客服工作台：${config.qianfanClientExePath}`;
      logFn('error', lastError);
      return { ok: false, phase: 'failed', lastError };
    }

    setPhase('launching');
    logFn('info', `[千帆] 正在以调试模式启动千帆客服工作台… 路径：${config.qianfanClientExePath}`);

    const clientConfig = toClientConfig();
    if (launchOptions.args) {
      clientConfig.qianfanClientArgs = launchOptions.args;
    }
    const launched = await launchClientFn(clientConfig, logFn);
    if (!launched.ok) {
      phase = 'failed';
      lastError = launched.error || '千帆客服工作台启动失败';
      logFn('error', `[千帆] 启动失败：${lastError}`);
      return { ok: false, phase: 'failed', lastError };
    }
    ownedPid = launched.pid || null;

    const waitResult = await waitForDevToolsProbe(clientConfig, clientConfig.waitTimeoutMs);
    if (!waitResult.ok) {
      if (waitResult.reason === 'timeout' && isQianfanProcessRunning(config.qianfanClientProcessName)) {
        logFn('warn', '[千帆] 千帆已打开但未检测到调试端口，正在重启为调试模式…');
        killExistingQianfanClient(config.qianfanClientProcessName);
        await waitForProcessExit(config.qianfanClientProcessName, config.closeWaitMs || 8000);
        const relaunched = await launchClientFn(clientConfig, logFn);
        if (relaunched.ok) {
          ownedPid = relaunched.pid || ownedPid;
          const retryWait = await waitForDevToolsProbe(clientConfig, clientConfig.waitTimeoutMs);
          if (retryWait.ok) {
            setPhase('ready');
            lastReadyAt = Date.now();
            lastError = '';
            logFn('info', `[千帆] DevTools ${config.devtoolsPort} 已就绪`);
            return { ok: true, phase: 'ready', ownedPid, list: retryWait.list };
          }
        }
      }
      phase = 'failed';
      lastError = waitResult.reason === 'timeout'
        ? (isQianfanProcessRunning(config.qianfanClientProcessName)
          ? `千帆已打开，但调试端口 ${config.devtoolsPort} 未生效，请关闭千帆后重试`
          : `千帆 DevTools ${config.devtoolsPort} 等待超时，请检查千帆安装路径`)
        : waitResult.reason || 'port_unavailable';
      logFn('error', `[千帆] ${lastError}`);
      return { ok: false, phase: 'failed', lastError };
    }

    phase = 'ready';
    lastReadyAt = Date.now();
    lastError = '';
    logFn('info', `[千帆] DevTools ${config.devtoolsPort} 已就绪`);
    return { ok: true, phase: 'ready', ownedPid, list: waitResult.list };
  }

  async function stopOwnedQianfan() {
    if (!ownedPid) return { ok: true, stopped: false };
    try {
      process.kill(ownedPid);
    } catch {
      // ignore
    }
    ownedPid = null;
    if (phase === 'ready' || phase === 'attached') phase = 'idle';
    return { ok: true, stopped: true };
  }

  function buildShopAttachResult(cdpResult) {
    const pages = cdpResult.pages || getPageTargets(cdpResult.list || []);
    const shopReport = detectQianfanShopPages(pages, {
      expectedShopCount: config.expectedShopCount,
    });
    return {
      devtoolsAccessible: true,
      list: cdpResult.list,
      pageCount: pages.length,
      shopReport,
      canStartListener: shopReport.detectedShopCount > 0,
    };
  }

  function setPhase(nextPhase) {
    phase = nextPhase;
    if (onPhase) onPhase(nextPhase, getStatus());
  }

  async function waitForShopPages(clientConfig, seedProbe = null) {
    const timeoutMs = clientConfig.waitTimeoutMs || config.waitTimeoutMs;
    const intervalMs = clientConfig.checkIntervalMs || config.checkIntervalMs;
    const started = Date.now();
    let lastAttachResult = null;
    let nextLogAt = started + 10000;

    setPhase('waiting_shops');
    logFn('info', '[千帆] 千帆已启动，正在等待店铺工作台页面加载…');

    while (Date.now() - started < timeoutMs) {
      const probe = seedProbe || await probeDevTools(clientConfig);
      seedProbe = null;
      if (!probe.ok) {
        return { ok: false, reason: probe.reason || 'unreachable', attachResult: lastAttachResult };
      }

      const attachResult = buildShopAttachResult(probeResultToCdp(probe));
      lastAttachResult = attachResult;
      if (attachResult.canStartListener) {
        const shopCount = attachResult.shopReport?.detectedShopCount || 0;
        logFn('info', `[千帆] 已检测到 ${shopCount} 个店铺工作台页面`);
        return { ok: true, attachResult, list: probe.list };
      }

      if (Date.now() >= nextLogAt) {
        const related = attachResult.shopReport?.relatedPageCount || 0;
        const waitedSec = Math.floor((Date.now() - started) / 1000);
        logFn('info', `[千帆] 等待店铺工作台页面… 已等待 ${waitedSec}s，相关页面 ${related} 个`);
        nextLogAt = Date.now() + 10000;
      }

      await sleep(intervalMs);
    }

    const probe = await probeDevTools(clientConfig);
    if (!probe.ok) {
      return { ok: false, reason: probe.reason || 'timeout', attachResult: lastAttachResult };
    }
    const attachResult = buildShopAttachResult(probeResultToCdp(probe));
    return {
      ok: attachResult.canStartListener,
      attachResult,
      list: probe.list,
      reason: attachResult.canStartListener ? undefined : 'shops_not_ready',
    };
  }

  async function ensureQianfanReady(ensureOptions = {}) {
    if (isSimMode()) {
      phase = 'ready';
      lastReadyAt = Date.now();
      lastError = '';
      return {
        ok: true,
        phase: 'ready',
        sim: true,
        attachResult: { canStartListener: true, sim: true },
        ...getStatus(),
      };
    }

    if (inFlight) return inFlight;

    inFlight = (async () => {
      if (!config.enabled) {
        phase = 'failed';
        lastError = '千帆调试模式已禁用';
        return { ok: false, phase: 'failed', lastError, ...getStatus() };
      }

      setPhase('checking');
      const clientConfig = toClientConfig();
      const exeExists = existsFn(config.qianfanClientExePath);
      const firstProbe = await probeDevTools(clientConfig);
      const debugAttached = firstProbe.ok
        && validateQianfanDevToolsProbe(firstProbe, { expectedShopCount: config.expectedShopCount }).valid;

      if (debugAttached) {
        setPhase('attached');
        lastReadyAt = Date.now();
        lastError = '';
        logFn('info', `[千帆] DevTools ${config.devtoolsPort}：可访问`);
        logFn('info', '[千帆] 已接入现有千帆调试端口');
        const cdp = probeResultToCdp(firstProbe);
        let attachResult = buildShopAttachResult(cdp);
        if (!attachResult.canStartListener) {
          const shopWait = await waitForShopPages(clientConfig, firstProbe);
          if (shopWait.attachResult) attachResult = shopWait.attachResult;
          if (!shopWait.ok && shopWait.reason && shopWait.reason !== 'shops_not_ready') {
            lastError = '千帆店铺工作台页面等待超时，请确认千帆已登录并完成店铺加载';
            logFn('warn', `[千帆] ${lastError}`);
          }
        }
        setPhase('attached');
        return {
          ok: true,
          phase: 'attached',
          alreadyRunning: true,
          attachResult,
          ...getStatus(),
        };
      }

      if (firstProbe.ok) {
        const port = config.devtoolsPort;
        if (isQianfanProcessRunning(config.qianfanClientProcessName)) {
          logFn('warn', `[千帆] 调试端口 ${port} 已开，但未检测到千帆页面，正在以调试模式重启…`);
          killExistingQianfanClient(config.qianfanClientProcessName);
          await waitForProcessExit(config.qianfanClientProcessName, config.closeWaitMs || 8000);
        } else {
          phase = 'failed';
          lastError = `${port} 端口已被其他程序占用（未检测到千帆页面），请关闭 Chrome/Edge 或修改 config.wxbot-new.json 里的 devtoolsPort`;
          logFn('error', `[千帆] ${lastError}`);
          return { ok: false, phase: 'failed', lastError, occupied: true, ...getStatus() };
        }
      } else if (firstProbe.occupied) {
        phase = 'failed';
        lastError = `${config.devtoolsPort} 端口被其他程序占用`;
        logFn('error', `[千帆] ${lastError}`);
        return { ok: false, phase: 'failed', lastError, occupied: true, ...getStatus() };
      } else {
        await closeQianfanClientIfRunning(config, (level, message) => logFn(level, message));
      }

      if (!firstProbe.ok && !exeExists && firstProbe.reason === 'unreachable') {
        phase = 'failed';
        lastError = `未找到千帆客服工作台：${config.qianfanClientExePath}`;
        logFn('error', lastError);
        return { ok: false, phase: 'failed', lastError, ...getStatus() };
      }

      const launchBlockedInWorker = process.env.QIANFAN_LAUNCH_BY_MAIN === '1'
        && isDistributedWorkerProcess();
      const autoLaunch = ensureOptions.autoLaunch !== false
        && ensureOptions.attachOnly !== true
        && config.autoLaunchQianfanClientWhenMissing
        && !launchBlockedInWorker;
      if (!autoLaunch) {
        const waitMs = Math.min(config.waitTimeoutMs || 60000, 30000);
        const waited = await waitForDevToolsProbe(clientConfig, waitMs);
        if (waited.ok) {
          setPhase('attached');
          lastReadyAt = Date.now();
          lastError = '';
          const cdp = probeResultToCdp(waited);
          let attachResult = buildShopAttachResult(cdp);
          if (!attachResult.canStartListener) {
            const shopWait = await waitForShopPages(clientConfig, waited);
            if (shopWait.attachResult) attachResult = shopWait.attachResult;
          }
          return {
            ok: true,
            phase: 'attached',
            alreadyRunning: true,
            attachResult,
            ...getStatus(),
          };
        }
        phase = launchBlockedInWorker ? 'waiting_launch' : 'degraded';
        lastError = launchBlockedInWorker
          ? '正在等待主进程启动千帆客服工作台…'
          : buildQianfanAttachHint(clientConfig, firstProbe);
        logFn('warn', `[千帆] ${lastError}`);
        return { ok: false, phase, lastError, ...getStatus() };
      }

      if (!exeExists) {
        phase = 'failed';
        lastError = `未找到千帆客服工作台：${config.qianfanClientExePath}`;
        logFn('error', lastError);
        return { ok: false, phase: 'failed', lastError, ...getStatus() };
      }

      const launched = await launchQianfanDebug();
      if (!launched.ok) {
        lastError = launched.lastError || lastError;
        return { ok: false, phase: launched.phase || 'failed', lastError, ...getStatus() };
      }

      const cdp = probeResultToCdp({ list: launched.list || [] });
      if (!launched.list) {
        phase = 'failed';
        lastError = '千帆 CDP 不可用';
        return { ok: false, phase: 'failed', lastError, ...getStatus() };
      }

      let attachResult = buildShopAttachResult(cdp);
      if (!attachResult.canStartListener) {
        const shopWait = await waitForShopPages(clientConfig);
        if (shopWait.attachResult) attachResult = shopWait.attachResult;
        if (!shopWait.ok && shopWait.reason && shopWait.reason !== 'shops_not_ready') {
          lastError = '千帆店铺工作台页面等待超时，请确认千帆已登录并完成店铺加载';
          logFn('warn', `[千帆] ${lastError}`);
        }
      }

      setPhase('ready');
      lastReadyAt = Date.now();
      return { ok: true, phase: 'ready', attachResult, ...getStatus() };
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return {
    checkDevToolsPort,
    checkCdpReady,
    ensureQianfanReady,
    launchQianfanDebug,
    stopOwnedQianfan,
    getStatus,
    getConfig: () => ({ ...config }),
    getLastDevToolsList: () => lastDevToolsList,
  };
}

module.exports = {
  createQianfanRuntimeController,
  resolveConfig,
  buildQianfanAttachHint,
  DEFAULT_CLIENT_EXE,
  DEFAULT_CLIENT_DIR,
};
