/**
 * 千帆客服工作台调试模式启动（--remote-debugging-port=9223）
 */
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { fetchDevToolsJsonList, getPageTargets } = require('./devtools-list');
const { validateQianfanDevToolsProbe } = require('./page-finder');
const { println } = require('./utils');
const { resolveProjectRoot } = require('./shared/app-root');

const DEFAULT_CLIENT_EXE = 'E:\\千帆\\eva\\千帆客服工作台.exe';
const DEFAULT_CLIENT_DIR = 'E:\\千帆\\eva';
const DEFAULT_CLIENT_PROCESS = '千帆客服工作台.exe';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildDefaultClientArgs(port, host) {
  return [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=${host}`,
    '--remote-allow-origins=*',
    '--disable-features=BlockInsecurePrivateNetworkRequests',
  ];
}

function resolveClientConfig(cfg = {}) {
  const port = Number(cfg.devtoolsPort || 9223);
  const host = cfg.devtoolsHost || '127.0.0.1';
  const defaultArgs = buildDefaultClientArgs(port, host);

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

async function closeQianfanClientIfRunning(config, logFn = println) {
  if (config.autoCloseExistingQianfanClient === false) return false;
  if (!isQianfanProcessRunning(config.qianfanClientProcessName)) return false;
  const log = (message) => {
    if (typeof logFn !== 'function') return;
    if (logFn.length >= 2) logFn('info', message);
    else logFn(message);
  };
  log('[千帆] 检测到千帆未以调试模式运行，正在关闭并以调试模式重新启动…');
  killExistingQianfanClient(config.qianfanClientProcessName);
  await waitForProcessExit(config.qianfanClientProcessName, config.closeWaitMs || 8000);
  return true;
}

function isDistributedWorkerProcess() {
  return process.env.QIANFAN_DISTRIBUTED_RUNTIME === '1' || typeof process.send === 'function';
}

function canLaunchQianfanGuiLocally() {
  if (process.platform !== 'win32') return true;
  return typeof process.send !== 'function';
}

function buildLaunchBatContent(config) {
  const exeName = path.basename(config.qianfanClientExePath);
  const argText = config.qianfanClientArgs.join(' ');
  return [
    '@echo off',
    `cd /d "${config.qianfanClientWorkingDir}"`,
    `start "" "${exeName}" ${argText}`,
  ].join('\r\n');
}

function writeLaunchBatFile(batPath, content) {
  fs.writeFileSync(batPath, content, 'utf8');
}

function launchQianfanClientViaCmdShell(config) {
  const exeName = path.basename(config.qianfanClientExePath);
  const argText = config.qianfanClientArgs.join(' ');
  const cmdLine = `cd /d "${config.qianfanClientWorkingDir}" && start "" "${exeName}" ${argText}`;
  const child = spawn(cmdLine, {
    shell: true,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { ok: true, method: 'cmd-shell', cmdLine, pid: child.pid || null };
}

function launchQianfanClientViaBat(config) {
  const runtimeDir = path.join(resolveProjectRoot(), 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const batPath = path.join(runtimeDir, 'launch-qianfan-debug.bat');
  writeLaunchBatFile(batPath, buildLaunchBatContent(config));
  return launchQianfanClientViaCmdShell(config);
}

function launchQianfanClientDirect(config) {
  const child = spawn(config.qianfanClientExePath, config.qianfanClientArgs, {
    cwd: config.qianfanClientWorkingDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return { ok: true, method: 'spawn', pid: child.pid || null };
}

function launchQianfanClientViaCmd(config) {
  return launchQianfanClientViaCmdShell(config);
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
    if (process.platform === 'win32') {
      return launchQianfanClientViaBat(config);
    }
    return launchQianfanClientDirect(config);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
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

  let launched;
  try {
    launched = launchQianfanClient(rawConfig);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  if (!launched.ok) {
    return launched;
  }

  log('info', `[千帆] 已通过 ${launched.method || 'cmd'} 以调试模式启动千帆客服工作台`);
  let signal = await waitForLaunchSignal(config, 20000);
  if (!signal.ok && process.platform === 'win32' && canLaunchQianfanGuiLocally()) {
    log('warn', '[千帆] cmd 启动未检测到调试端口，正在尝试直接启动千帆…');
    launched = launchQianfanClientDirect(config);
    if (!launched.ok) {
      return launched;
    }
    signal = await waitForLaunchSignal(config, 40000);
  }
  if (signal.ok) {
    return {
      ...launched,
      processStarted: true,
      devtoolsReady: signal.via === 'devtools',
    };
  }

  return {
    ok: false,
    error: '千帆客服工作台未能启动，请检查安装路径或手动运行「启动千帆调试模式.bat」',
  };
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

/**
 * 确保千帆客服工作台以调试模式就绪（自动检测 / 关闭非调试进程 / 调试模式启动）
 * @param {object} cfg qianfanDebug 配置
 */
async function ensureQianfanClientDebugReady(cfg) {
  const config = resolveClientConfig(cfg);
  const expectedShopCount = Number(cfg?.expectedShopCount || 4);

  if (!config.enabled) {
    return { ok: false, devtoolsAccessible: false, reason: 'disabled' };
  }

  const firstProbe = await probeDevTools(config);
  const debugAttached = firstProbe.ok
    && validateQianfanDevToolsProbe(firstProbe, { expectedShopCount }).valid;

  if (debugAttached) {
    println(`[千帆] DevTools ${config.devtoolsPort}：可访问`);
    println('[千帆] 已接入现有千帆调试端口');
    return {
      ok: true,
      devtoolsAccessible: true,
      alreadyRunning: true,
      pageCount: firstProbe.pageCount,
      list: firstProbe.list,
    };
  }

  if (firstProbe.ok) {
    const port = config.devtoolsPort;
    if (isQianfanProcessRunning(config.qianfanClientProcessName)) {
      println(`[千帆] 调试端口 ${port} 已开，但未检测到千帆页面，正在以调试模式重启…`);
      killExistingQianfanClient(config.qianfanClientProcessName);
      await sleep(config.closeWaitMs || 2000);
    } else {
      println(`[千帆] DevTools ${port}：不可访问`);
      println(`[错误] ${port} 端口已被其他程序占用，请关闭 Chrome/Edge 或修改 config.wxbot-new.json 里的 devtoolsPort`);
      return {
        ok: false,
        devtoolsAccessible: false,
        reason: 'port_occupied',
        occupied: true,
      };
    }
  } else if (firstProbe.occupied) {
    println(`[千帆] DevTools ${config.devtoolsPort}：不可访问`);
    println(`[错误] ${config.devtoolsPort} 端口被其他程序占用，返回内容不是 Chrome DevTools`);
    return {
      ok: false,
      devtoolsAccessible: false,
      reason: 'port_occupied',
      occupied: true,
    };
  } else {
    await closeQianfanClientIfRunning(config);
  }

  if (!config.autoLaunchQianfanClientWhenMissing) {
    if (isQianfanProcessRunning(config.qianfanClientProcessName)) {
      println(`[千帆] 千帆已在运行，但未开启调试端口 ${config.devtoolsPort}`);
    }
    return { ok: false, devtoolsAccessible: false, reason: 'unreachable' };
  }

  if (!fs.existsSync(config.qianfanClientExePath)) {
    println(`[错误] 未找到千帆客服工作台：${config.qianfanClientExePath}`);
    println('[操作] 请确认千帆安装路径是否正确（config.wxbot-new.json → qianfanDebug.qianfanClientExePath）');
    return { ok: false, devtoolsAccessible: false, reason: 'client_not_found' };
  }

  println('[千帆] 正在以调试模式启动千帆客服工作台...');
  println(`[千帆] 路径：${config.qianfanClientExePath}`);
  println(`[千帆] DevTools 端口：${config.devtoolsPort}`);

  const launched = await launchQianfanClientAndVerify(config, println);
  if (!launched.ok) {
    println(`[错误] 千帆客服工作台启动失败：${launched.error}`);
    println(`[操作] 请确认 ${config.qianfanClientExePath} 能正常启动`);
    return { ok: false, devtoolsAccessible: false, reason: 'launch_failed' };
  }

  const waitResult = await waitForDevTools(config);
  if (waitResult.ok) {
    println(`[千帆] DevTools ${config.devtoolsPort}：可访问`);
    println('[千帆] 千帆客服工作台调试模式已启动');
    return waitResult;
  }

  println(`[错误] 千帆 DevTools ${config.devtoolsPort} 仍不可访问`);
  println('[原因] 千帆客服工作台可能启动失败，或调试参数未生效');
  println(`[操作] 请确认 ${config.qianfanClientExePath} 能正常启动`);
  return waitResult;
}

module.exports = {
  ensureQianfanClientDebugReady,
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
  launchQianfanClientViaBat,
  launchQianfanClientViaCmd,
  launchQianfanClientViaCmdShell,
  launchQianfanClientDirect,
  launchQianfanClientAndVerify,
  buildLaunchBatContent,
  writeLaunchBatFile,
  DEFAULT_CLIENT_EXE,
  DEFAULT_CLIENT_DIR,
  DEFAULT_CLIENT_PROCESS,
};
