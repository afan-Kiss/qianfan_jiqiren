/**
 * 千帆客服工作台调试模式启动（--remote-debugging-port=9223）
 */
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { fetchDevToolsJsonList, getPageTargets } = require('./devtools-list');
const { println } = require('./utils');
const { resolveProjectRoot } = require('./shared/app-root');

const DEFAULT_CLIENT_EXE = 'E:\\千帆\\eva\\千帆客服工作台.exe';
const DEFAULT_CLIENT_DIR = 'E:\\千帆\\eva';
const DEFAULT_CLIENT_PROCESS = '千帆客服工作台.exe';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildDefaultClientArgs(port) {
  return [`--remote-debugging-port=${port}`];
}

function resolveClientConfig(cfg = {}) {
  const port = Number(cfg.devtoolsPort || 9223);
  const host = cfg.devtoolsHost || '127.0.0.1';
  const defaultArgs = buildDefaultClientArgs(port);

  let args = defaultArgs;
  if (Array.isArray(cfg.qianfanClientArgs) && cfg.qianfanClientArgs.length) {
    args = cfg.qianfanClientArgs.map((arg) =>
      String(arg)
        .replace(/9223/g, String(port))
        .replace(/127\.0\.0\.1/g, host)
    );
  }

  return {
    enabled: cfg.enabled !== false,
    devtoolsPort: port,
    devtoolsHost: host,
    autoLaunchQianfanClientWhenMissing: cfg.autoLaunchQianfanClientWhenMissing !== false,
    autoCloseExistingQianfanClient: cfg.autoCloseExistingQianfanClient !== false,
    qianfanClientExePath: String(cfg.qianfanClientExePath || DEFAULT_CLIENT_EXE).trim(),
    qianfanClientWorkingDir: String(cfg.qianfanClientWorkingDir || DEFAULT_CLIENT_DIR).trim(),
    qianfanClientProcessName: String(cfg.qianfanClientProcessName || DEFAULT_CLIENT_PROCESS).trim(),
    qianfanClientArgs: args,
    waitTimeoutMs: Number(cfg.waitTimeoutMs || 60000),
    checkIntervalMs: Number(cfg.checkIntervalMs || 2000),
    closeWaitMs: Number(cfg.closeWaitMs || 2000),
  };
}

async function probeDevTools(config) {
  const base = `http://${config.devtoolsHost}:${config.devtoolsPort}`;
  try {
    const versionRes = await fetch(`${base}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!versionRes.ok) {
      return { ok: false, occupied: true, reason: `HTTP ${versionRes.status}` };
    }
    const version = await versionRes.json();
    if (!version || !version.Browser) {
      return { ok: false, occupied: true, reason: 'not_chrome_devtools' };
    }

    const list = await fetchDevToolsJsonList(config.devtoolsPort, config.devtoolsHost);
    const pageCount = getPageTargets(list).length;
    return { ok: true, pageCount, list, browser: version.Browser };
  } catch (err) {
    const msg = String(err.message || err);
    if (/fetch failed|ECONNREFUSED|timeout/i.test(msg)) {
      return { ok: false, occupied: false, reason: 'unreachable' };
    }
    return { ok: false, occupied: false, reason: msg };
  }
}

function killExistingQianfanClient(processName) {
  try {
    execSync(`taskkill /F /IM "${processName}"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isQianfanProcessRunning(processName = DEFAULT_CLIENT_PROCESS) {
  try {
    const output = execSync(`tasklist /FI "IMAGENAME eq ${processName}" /NH`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /\.exe/i.test(output) && !/No tasks are running/i.test(output) && !/没有运行的任务/i.test(output);
  } catch {
    return false;
  }
}

async function waitForProcessExit(processName, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isQianfanProcessRunning(processName)) return true;
    await sleep(400);
  }
  return !isQianfanProcessRunning(processName);
}

async function waitForProcessStart(processName, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (isQianfanProcessRunning(processName)) return true;
    await sleep(400);
  }
  return isQianfanProcessRunning(processName);
}

function isDistributedWorkerProcess() {
  return process.env.QIANFAN_DISTRIBUTED_RUNTIME === '1' || typeof process.send === 'function';
}

function canLaunchQianfanGuiLocally() {
  if (process.platform !== 'win32') return true;
  return typeof process.send !== 'function';
}

function buildCmdStartInner(config) {
  const exe = config.qianfanClientExePath;
  const argText = config.qianfanClientArgs.join(' ');
  return `start "" "${exe}" ${argText}`;
}

function buildCmdStartCommand(config) {
  return `cmd.exe /d /s /c ${buildCmdStartInner(config)}`;
}

function launchQianfanClientViaCmdStart(config) {
  const inner = buildCmdStartInner(config);
  const child = spawn('cmd.exe', ['/d', '/s', '/c', inner], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: config.qianfanClientWorkingDir,
  });
  child.unref();
  return {
    ok: true,
    method: 'cmd-start',
    cmdLine: buildCmdStartCommand(config),
    pid: child.pid || null,
  };
}

function launchQianfanClient(rawConfig) {
  const config = resolveClientConfig(rawConfig);
  if (!fs.existsSync(config.qianfanClientExePath)) {
    return { ok: false, error: `未找到千帆客服工作台：${config.qianfanClientExePath}` };
  }
  if (!canLaunchQianfanGuiLocally()) {
    return { ok: false, error: '当前进程无法启动千帆 GUI，请由主进程启动' };
  }
  try {
    return launchQianfanClientViaCmdStart(config);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function waitForDevTools(config) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < config.waitTimeoutMs) {
    const probe = await probeDevTools(config);
    if (probe.ok) {
      return {
        ok: true,
        devtoolsAccessible: true,
        pageCount: probe.pageCount,
        list: probe.list,
        probe,
      };
    }

    if (probe.occupied && probe.reason === 'not_chrome_devtools') {
      return {
        ok: false,
        devtoolsAccessible: false,
        reason: 'port_occupied',
        occupied: true,
      };
    }

    await sleep(config.checkIntervalMs);
  }

  return { ok: false, devtoolsAccessible: false, reason: 'timeout' };
}

async function waitForLaunchSignal(config, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const probe = await probeDevTools(config);
    if (probe.ok) {
      return { ok: true, via: 'devtools', probe };
    }
    if (isQianfanProcessRunning(config.qianfanClientProcessName)) {
      return { ok: true, via: 'process' };
    }
    await sleep(500);
  }
  const probe = await probeDevTools(config);
  if (probe.ok) {
    return { ok: true, via: 'devtools', probe };
  }
  return { ok: false };
}

async function launchQianfanClientAndVerify(rawConfig, logFn = println) {
  const config = resolveClientConfig(rawConfig);
  const log = (level, message) => {
    if (typeof logFn !== 'function') return;
    if (logFn.length >= 2) logFn(level, message);
    else logFn(message);
  };

  const launched = launchQianfanClient(rawConfig);
  if (!launched.ok) {
    return launched;
  }

  log('info', `[千帆] 已执行：${launched.cmdLine || buildCmdStartCommand(config)}`);
  const signal = await waitForLaunchSignal(config, config.waitTimeoutMs || 60000);
  if (signal.ok) {
    return {
      ...launched,
      processStarted: true,
      devtoolsReady: signal.via === 'devtools',
    };
  }

  return {
    ok: false,
    error: `千帆 DevTools ${config.devtoolsPort} 等待超时，请手动运行：${buildCmdStartCommand(config)}`,
  };
}

/**
 * 确保千帆 DevTools 端口就绪（不等待店铺页面）
 */
async function ensureQianfanDevToolsReady(cfg, options = {}) {
  const config = resolveClientConfig(cfg);
  const log = (level, message) => {
    if (typeof options.log !== 'function') return;
    options.log(level, message);
  };
  const canLaunch = options.canLaunch !== false && canLaunchQianfanGuiLocally();

  if (!config.enabled) {
    return { ok: false, reason: 'disabled', lastError: '千帆调试模式已禁用' };
  }

  const firstProbe = await probeDevTools(config);
  if (firstProbe.ok) {
    log('info', `[千帆] DevTools ${config.devtoolsPort}：可访问`);
    return {
      ok: true,
      phase: 'attached',
      alreadyRunning: true,
      devtoolsAccessible: true,
      probe: firstProbe,
      pageCount: firstProbe.pageCount,
      list: firstProbe.list,
    };
  }

  if (firstProbe.occupied) {
    return {
      ok: false,
      reason: 'port_occupied',
      lastError: `${config.devtoolsPort} 端口被其他程序占用`,
      occupied: true,
    };
  }

  if (!canLaunch) {
    const attachWaitMs = Number(options.attachWaitMs || Math.min(config.waitTimeoutMs, 30000));
    const waited = await waitForDevTools({ ...config, waitTimeoutMs: attachWaitMs });
    if (waited.ok) {
      return {
        ok: true,
        phase: 'attached',
        alreadyRunning: true,
        devtoolsAccessible: true,
        probe: waited.probe,
        pageCount: waited.pageCount,
        list: waited.list,
      };
    }
    return {
      ok: false,
      reason: 'waiting_launch',
      lastError: '正在等待主进程启动千帆客服工作台…',
    };
  }

  if (!fs.existsSync(config.qianfanClientExePath)) {
    return {
      ok: false,
      reason: 'client_not_found',
      lastError: `未找到千帆客服工作台：${config.qianfanClientExePath}`,
    };
  }

  if (isQianfanProcessRunning(config.qianfanClientProcessName)) {
    if (config.autoCloseExistingQianfanClient === false) {
      return {
        ok: false,
        reason: 'no_debug_port',
        lastError: `千帆已运行但未开启调试端口 ${config.devtoolsPort}，请关闭后重试`,
      };
    }
    log('info', '[千帆] 千帆已在运行但未开启调试端口，正在关闭并以调试模式重新启动…');
    killExistingQianfanClient(config.qianfanClientProcessName);
    await waitForProcessExit(config.qianfanClientProcessName, config.closeWaitMs || 8000);
  }

  const doLaunch = options.launchFn || launchQianfanClient;
  log('info', `[千帆] 正在执行 cmd 启动：${buildCmdStartCommand(config)}`);
  const launched = await Promise.resolve(doLaunch(config));
  if (!launched.ok) {
    return {
      ok: false,
      reason: 'launch_failed',
      lastError: launched.error || '千帆启动失败',
    };
  }

  const waitResult = await waitForDevTools(config);
  if (!waitResult.ok) {
    return {
      ok: false,
      reason: waitResult.reason || 'timeout',
      lastError: `千帆 DevTools ${config.devtoolsPort} 等待超时，请手动运行：${buildCmdStartCommand(config)}`,
    };
  }

  log('info', `[千帆] DevTools ${config.devtoolsPort} 已就绪`);
  return {
    ok: true,
    phase: 'ready',
    devtoolsAccessible: true,
    launched: true,
    pid: launched.pid || null,
    probe: waitResult.probe,
    pageCount: waitResult.pageCount,
    list: waitResult.list,
  };
}

async function closeQianfanClientIfRunning(config, logFn = println) {
  if (config.autoCloseExistingQianfanClient === false) return false;
  if (!isQianfanProcessRunning(config.qianfanClientProcessName)) return false;
  const probe = await probeDevTools(config);
  if (probe.ok) return false;
  const log = (message) => {
    if (typeof logFn !== 'function') return;
    if (logFn.length >= 2) logFn('info', message);
    else logFn(message);
  };
  log('[千帆] 千帆已在运行但未开启调试端口，正在关闭并以调试模式重新启动…');
  killExistingQianfanClient(config.qianfanClientProcessName);
  await waitForProcessExit(config.qianfanClientProcessName, config.closeWaitMs || 8000);
  return true;
}

async function ensureQianfanClientDebugReady(cfg) {
  const result = await ensureQianfanDevToolsReady(cfg, {
    log: (level, message) => println(message),
  });
  if (!result.ok) {
    return {
      ok: false,
      devtoolsAccessible: false,
      reason: result.reason,
      lastError: result.lastError,
    };
  }
  return {
    ok: true,
    devtoolsAccessible: true,
    alreadyRunning: result.alreadyRunning === true,
    pageCount: result.pageCount,
    list: result.list,
  };
}

function buildLaunchBatContent(config) {
  return [
    '@echo off',
    `cd /d "${config.qianfanClientWorkingDir}"`,
    buildCmdStartInner(config),
  ].join('\r\n');
}

function writeLaunchBatFile(batPath, content) {
  fs.writeFileSync(batPath, content, 'utf8');
}

module.exports = {
  ensureQianfanClientDebugReady,
  ensureQianfanDevToolsReady,
  resolveClientConfig,
  probeDevTools,
  killExistingQianfanClient,
  isQianfanProcessRunning,
  isDistributedWorkerProcess,
  canLaunchQianfanGuiLocally,
  waitForProcessExit,
  waitForProcessStart,
  waitForLaunchSignal,
  closeQianfanClientIfRunning,
  launchQianfanClient,
  launchQianfanClientViaCmdStart,
  launchQianfanClientAndVerify,
  buildCmdStartInner,
  buildCmdStartCommand,
  buildLaunchBatContent,
  writeLaunchBatFile,
  waitForDevTools,
  DEFAULT_CLIENT_EXE,
  DEFAULT_CLIENT_DIR,
  DEFAULT_CLIENT_PROCESS,
};
