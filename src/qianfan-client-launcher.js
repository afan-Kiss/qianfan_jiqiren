/**
 * 千帆客服工作台调试模式启动（默认 DevTools 9322；9223 在部分 Windows 上被系统保留）
 */
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { fetchDevToolsJsonList, getPageTargets } = require('./devtools-list');
const { println } = require('./utils');
const { resolveProjectRoot } = require('./shared/app-root');
const {
  DEFAULT_DEVTOOLS_PORT,
  LEGACY_DEVTOOLS_PORT,
  FALLBACK_DEVTOOLS_PORTS,
  buildPortExcludedError,
  isWindowsPortExcluded,
  resolveDevToolsPort,
  suggestDevToolsPort,
} = require('./shared/windows-devtools-port');
const {
  setDetectedDevToolsPort,
  resolveEffectiveDevToolsPort,
} = require('./shared/qianfan-devtools-port-runtime');

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
  const configuredPort = resolveEffectiveDevToolsPort(cfg.devtoolsPort);
  const portResolution = resolveDevToolsPort(configuredPort);
  const port = portResolution.port;
  const host = cfg.devtoolsHost || '127.0.0.1';
  const defaultArgs = buildDefaultClientArgs(port);

  let args = defaultArgs;
  if (Array.isArray(cfg.qianfanClientArgs) && cfg.qianfanClientArgs.length) {
    args = cfg.qianfanClientArgs.map((arg) =>
      String(arg)
        .replace(/9223/g, String(port))
        .replace(/9322/g, String(port))
        .replace(/127\.0\.0\.1/g, host)
    );
  }

  return {
    enabled: cfg.enabled !== false,
    devtoolsPort: port,
    devtoolsPortRequested: portResolution.requestedPort,
    devtoolsPortAdjusted: portResolution.adjusted === true,
    devtoolsHost: host,
    autoLaunchQianfanClientWhenMissing: cfg.autoLaunchQianfanClientWhenMissing !== false,
    autoCloseExistingQianfanClient: cfg.autoCloseExistingQianfanClient === true,
    qianfanClientExePath: String(cfg.qianfanClientExePath || DEFAULT_CLIENT_EXE).trim(),
    qianfanClientWorkingDir: String(cfg.qianfanClientWorkingDir || DEFAULT_CLIENT_DIR).trim(),
    qianfanClientProcessName: String(cfg.qianfanClientProcessName || DEFAULT_CLIENT_PROCESS).trim(),
    qianfanClientArgs: args,
    waitTimeoutMs: Number(cfg.waitTimeoutMs || 120000),
    checkIntervalMs: Number(cfg.checkIntervalMs || 2000),
    closeWaitMs: Number(cfg.closeWaitMs || 10000),
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

function runPowerShell(script, extraEnv = {}) {
  const envPrefix = Object.entries(extraEnv)
    .map(([key, value]) => `$env:${key}='${String(value).replace(/'/g, "''")}'`)
    .join('; ');
  const command = envPrefix ? `${envPrefix}; ${script}` : script;
  return execSync(`powershell -NoProfile -Command "${command}"`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10000,
  });
}

function killExistingQianfanClient(processName) {
  try {
    execSync(`taskkill /F /T /IM "${processName}"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function countQianfanProcesses(processName = DEFAULT_CLIENT_PROCESS) {
  if (process.platform !== 'win32') return 0;
  try {
    const output = runPowerShell([
      'Get-CimInstance Win32_Process',
      '| Where-Object { $_.Name -eq $env:QIANFAN_PROC_NAME }',
      '| Measure-Object',
      '| Select-Object -ExpandProperty Count',
    ].join(' '), { QIANFAN_PROC_NAME: processName });
    return Number(String(output).trim()) || 0;
  } catch {
    try {
      const output = execSync(`tasklist /FI "IMAGENAME eq ${processName}" /NH`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (!/\.exe/i.test(output) || /No tasks are running/i.test(output) || /没有运行的任务/i.test(output)) {
        return 0;
      }
      return output.split(/\r?\n/).filter((line) => /\.exe/i.test(line)).length;
    } catch {
      return 0;
    }
  }
}

function listQianfanMainProcessCommandLines(processName = DEFAULT_CLIENT_PROCESS) {
  if (process.platform !== 'win32') return [];
  try {
    const output = runPowerShell([
      'Get-CimInstance Win32_Process',
      '| Where-Object { $_.Name -eq $env:QIANFAN_PROC_NAME -and $_.CommandLine -and ($_.CommandLine -notmatch \'--type=\') }',
      '| Select-Object -ExpandProperty CommandLine',
    ].join(' '), { QIANFAN_PROC_NAME: processName });
    return String(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function mainProcessHasDebugPortArg(config, port = config.devtoolsPort) {
  const value = Number(port);
  if (!Number.isFinite(value) || value <= 0) return false;
  const pattern = new RegExp(`remote-debugging-port=${value}(\\D|$)|inspect=${value}(\\D|$)`, 'i');
  return listQianfanMainProcessCommandLines(config.qianfanClientProcessName)
    .some((line) => pattern.test(line));
}

function parseDebugPortsFromText(text) {
  const ports = [];
  const re = /remote-debugging-port=(\d+)/gi;
  let match;
  while ((match = re.exec(String(text || ''))) !== null) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) ports.push(value);
  }
  return ports;
}

function listQianfanProcessDebugPorts(config) {
  const ports = [];
  for (const line of listQianfanMainProcessCommandLines(config.qianfanClientProcessName)) {
    ports.push(...parseDebugPortsFromText(line));
  }
  return [...new Set(ports)];
}

function mainProcessHasAnyDebugPortArg(config) {
  return listQianfanProcessDebugPorts(config).length > 0;
}

function collectDevToolsProbePorts(config) {
  const ports = [
    config.devtoolsPort,
    ...listQianfanProcessDebugPorts(config),
    LEGACY_DEVTOOLS_PORT,
    ...FALLBACK_DEVTOOLS_PORTS,
  ];
  return [...new Set(ports.filter((value) => Number.isFinite(value) && value > 0))];
}

async function probeDevToolsOnPorts(config, ports = null) {
  const tryPorts = ports || collectDevToolsProbePorts(config);
  for (const port of tryPorts) {
    const probe = await probeDevTools({ ...config, devtoolsPort: port });
    if (probe.ok) {
      setDetectedDevToolsPort(port);
      return { ...probe, devtoolsPort: port, matchedPort: port };
    }
  }
  return { ok: false, reason: 'unreachable', triedPorts: tryPorts };
}

function rememberDevToolsProbe(probe) {
  if (probe?.ok && probe.devtoolsPort) {
    setDetectedDevToolsPort(probe.devtoolsPort);
  } else if (probe?.matchedPort) {
    setDetectedDevToolsPort(probe.matchedPort);
  }
}

async function waitForDevToolsAttach(config, options = {}, logFn = null) {
  const log = createLaunchLogger(logFn);
  const timeoutMs = Number(
    options.attachWaitMs
    || options.waitTimeoutMs
    || Math.max(config.waitTimeoutMs || 60000, 120000),
  );
  log('info', `[千帆] 等待 DevTools ${config.devtoolsPort} 就绪（最多 ${Math.floor(timeoutMs / 1000)}s）…`);
  return waitForDevTools({ ...config, waitTimeoutMs: timeoutMs });
}

async function forceStopQianfanClient(processName, timeoutMs = 12000, logFn = null) {
  const log = createLaunchLogger(logFn);
  const before = countQianfanProcesses(processName);
  if (before <= 0) return { stopped: true, before: 0, after: 0 };

  log('info', `[千帆] 正在结束 ${before} 个千帆进程…`);
  killExistingQianfanClient(processName);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const remaining = countQianfanProcesses(processName);
    if (remaining <= 0) {
      await sleep(800);
      return { stopped: true, before, after: 0 };
    }
    if (Date.now() - started > timeoutMs / 2) {
      killExistingQianfanClient(processName);
    }
    await sleep(500);
  }
  const after = countQianfanProcesses(processName);
  return { stopped: after <= 0, before, after };
}

async function isQianfanClientInDebugMode(rawConfig) {
  const config = resolveClientConfig(rawConfig);
  const running = isQianfanProcessRunning(config.qianfanClientProcessName);
  if (!running) {
    return { running: false, debugMode: false };
  }
  const probe = await probeDevTools(config);
  return { running: true, debugMode: probe.ok === true, probe };
}

function isRuntimeShuttingDown() {
  return process.env.QIANFAN_RUNTIME_SHUTTING_DOWN === '1';
}

/**
 * 仅当千帆在运行且未开启调试端口时才结束进程（用于切换为调试模式启动）。
 * 必须显式 allowKill:true；退出/停止中转/attach 探测时一律不结束千帆。
 */
async function killQianfanClientIfNotInDebugMode(rawConfig, options = {}) {
  const config = resolveClientConfig(rawConfig);
  const log = createLaunchLogger(options.log);

  if (isRuntimeShuttingDown()) {
    return { killed: false, reason: 'runtime_shutting_down' };
  }

  if (options.allowKill !== true) {
    return { killed: false, reason: 'kill_not_allowed' };
  }

  if (!isQianfanProcessRunning(config.qianfanClientProcessName)) {
    return { killed: false, reason: 'not_running' };
  }

  const multiProbe = await probeDevToolsOnPorts(config);
  if (multiProbe.ok) {
    log(
      'info',
      `[千帆] 千帆已在调试模式运行（DevTools ${multiProbe.devtoolsPort}），不会结束进程`,
    );
    return { killed: false, reason: 'debug_mode', probe: multiProbe };
  }

  if (mainProcessHasAnyDebugPortArg(config)) {
    const ports = listQianfanProcessDebugPorts(config);
    log(
      'info',
      `[千帆] 千帆主进程已带调试参数（端口 ${ports.join('/')}），等待 DevTools 就绪（不会结束进程）`,
    );
    return { killed: false, reason: 'debug_launch_pending', debugPorts: ports };
  }

  if (config.autoCloseExistingQianfanClient === false) {
    return {
      killed: false,
      reason: 'auto_close_disabled',
      lastError: `千帆已运行但未检测到 DevTools，已禁用自动关闭（已尝试端口 ${collectDevToolsProbePorts(config).join(', ')}）`,
    };
  }

  log('info', '[千帆] 千帆已在运行但未检测到 DevTools，正在关闭并以调试模式重新启动…');
  const stopResult = await forceStopQianfanClient(
    config.qianfanClientProcessName,
    options.closeWaitMs || config.closeWaitMs || 12000,
    options.log,
  );
  if (!stopResult.stopped) {
    return {
      killed: false,
      reason: 'stop_incomplete',
      lastError: `仍有 ${stopResult.after} 个千帆进程未退出，请手动全部关闭后重试`,
    };
  }
  return { killed: true, reason: 'not_debug_mode' };
}

function isQianfanProcessRunning(processName = DEFAULT_CLIENT_PROCESS) {
  return countQianfanProcesses(processName) > 0;
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

function buildLaunchCommandLine(config) {
  const exe = config.qianfanClientExePath;
  const argText = config.qianfanClientArgs.join(' ');
  return `"${exe}" ${argText}`;
}

function buildCmdStartInner(config) {
  const exe = config.qianfanClientExePath;
  const argText = config.qianfanClientArgs.join(' ');
  return `start "" "${exe}" ${argText}`;
}

function buildCmdStartCommand(config) {
  return `cmd.exe /d /s /c ${buildCmdStartInner(config)}`;
}

function createLaunchLogger(logFn) {
  return (level, message) => {
    if (typeof logFn !== 'function') return;
    if (logFn.length >= 2) logFn(level, message);
    else logFn(message);
  };
}

function spawnQianfanClientDirect(config) {
  const args = [...config.qianfanClientArgs];
  const child = spawn(config.qianfanClientExePath, args, {
    cwd: config.qianfanClientWorkingDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    shell: false,
  });
  child.unref();
  return { child, method: 'direct-spawn' };
}

function spawnQianfanClientShellFallback(config) {
  const command = buildLaunchCommandLine(config);
  const child = spawn(command, {
    cwd: config.qianfanClientWorkingDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    shell: true,
  });
  child.unref();
  return { child, method: 'shell-fallback' };
}

/** @deprecated 仅保留给 bat 生成；主启动请使用 launchQianfanClient */
function spawnQianfanClientViaCmdStart(config) {
  const inner = buildCmdStartInner(config);
  const child = spawn('cmd.exe', ['/d', '/s', '/c', inner], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    cwd: config.qianfanClientWorkingDir,
  });
  child.unref();
  return { child, method: 'cmd-start' };
}

async function launchQianfanClient(rawConfig, logFn = println) {
  const config = resolveClientConfig(rawConfig);
  const log = createLaunchLogger(logFn);

  if (!fs.existsSync(config.qianfanClientExePath)) {
    return { ok: false, error: `未找到千帆客服工作台：${config.qianfanClientExePath}` };
  }
  if (!canLaunchQianfanGuiLocally()) {
    return { ok: false, error: '当前进程无法启动千帆 GUI，请由主进程启动' };
  }

  if (countQianfanProcesses(config.qianfanClientProcessName) > 0) {
    const existingProbe = await probeDevToolsOnPorts(config);
    if (existingProbe.ok) {
      log(
        'info',
        `[千帆] 千帆已在调试模式运行（DevTools ${existingProbe.devtoolsPort}），跳过重复拉起`,
      );
      return {
        ok: true,
        method: 'attach-existing',
        processStarted: true,
        devtoolsReady: true,
        probe: existingProbe,
        pageCount: existingProbe.pageCount,
        list: existingProbe.list,
      };
    }
    if (mainProcessHasAnyDebugPortArg(config)) {
      log('info', '[千帆] 检测到千帆已在调试模式启动中，跳过重复拉起');
      const waitConfig = resolveClientConfig({
        ...rawConfig,
        devtoolsPort: listQianfanProcessDebugPorts(config)[0] || config.devtoolsPort,
      });
      const waitResult = await waitForDevToolsAttach(waitConfig, {}, logFn);
      if (waitResult.ok) {
        rememberDevToolsProbe(waitResult.probe);
        return {
          ok: true,
          method: 'attach-pending',
          processStarted: true,
          devtoolsReady: true,
          probe: waitResult.probe,
          pageCount: waitResult.pageCount,
          list: waitResult.list,
        };
      }
      return {
        ok: false,
        error: `千帆已带调试参数启动，但 DevTools 等待超时。请确认千帆已登录并完成店铺工作台加载（已尝试端口 ${collectDevToolsProbePorts(config).join(', ')}）`,
        method: 'attach-pending',
        processStarted: true,
        processCount: countQianfanProcesses(config.qianfanClientProcessName),
      };
    }
    if (config.autoCloseExistingQianfanClient === false) {
      return {
        ok: false,
        error: `千帆已在运行但未检测到 DevTools，且已禁用自动关闭。请手动以调试模式启动或修改 devtoolsPort`,
      };
    }
    const stopResult = await forceStopQianfanClient(
      config.qianfanClientProcessName,
      config.closeWaitMs || 12000,
      logFn,
    );
    if (!stopResult.stopped) {
      return {
        ok: false,
        error: `仍有 ${stopResult.after} 个千帆进程未退出，请手动全部关闭后重试`,
      };
    }
  }

  log('info', `[千帆] 准备启动 exe：${config.qianfanClientExePath}`);
  log('info', `[千帆] 启动参数：${config.qianfanClientArgs.join(' ')}`);

  let child;
  let method = 'shell-exact';
  const batPath = path.join(config.qianfanClientWorkingDir, '_qianfan_debug_launch.bat');
  const batContent = buildLaunchBatContent(config);
  try {
    if (!fs.existsSync(batPath) || fs.readFileSync(batPath, 'utf8') !== batContent) {
      writeLaunchBatFile(batPath, batContent);
      log('info', `[千帆] 已同步调试启动脚本：${batPath}`);
    }
    child = spawn(buildLaunchCommandLine(config), {
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd: config.qianfanClientWorkingDir,
    });
    child.unref();
  } catch (err) {
    log('warn', `[千帆] shell 启动失败，尝试 bat：${err.message || err}`);
    try {
      child = spawn('cmd.exe', ['/d', '/s', '/c', `"${batPath}"`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd: config.qianfanClientWorkingDir,
      });
      method = 'bundled-bat';
      child.unref();
    } catch (fallbackErr) {
      return { ok: false, error: fallbackErr.message || String(fallbackErr) };
    }
  }

  log('info', `[千帆] spawn pid=${child.pid || 'unknown'} (${method})`);

  const processStarted = await waitForProcessStart(config.qianfanClientProcessName, 30000);
  const processCount = countQianfanProcesses(config.qianfanClientProcessName);
  log('info', `[千帆] tasklist 检测千帆进程：${processStarted ? `存在 ${processCount} 个` : '不存在'}`);
  if (!processStarted) {
    return {
      ok: false,
      error: '已执行启动命令，但未检测到 千帆客服工作台.exe 进程',
      method,
      pid: child.pid || null,
    };
  }

  const waitResult = await waitForDevToolsAttach(config, {}, logFn);
  log('info', `[千帆] DevTools ${config.devtoolsPort} 检测：${waitResult.ok ? '成功' : '失败'}`);
  if (!waitResult.ok) {
    const error = waitResult.reason === 'port_occupied'
      ? `${config.devtoolsPort} 端口被其他程序占用`
      : `千帆进程已启动，但 DevTools ${config.devtoolsPort} 等待超时。请确认千帆已登录并完成店铺工作台加载，或手动运行「启动千帆调试模式.bat」`;
    return {
      ok: false,
      error,
      method,
      pid: child.pid || null,
      processStarted: true,
      processCount,
    };
  }

  return {
    ok: true,
    method,
    cmdLine: buildLaunchCommandLine(config),
    pid: child.pid || null,
    processStarted: true,
    devtoolsReady: true,
    probe: waitResult.probe,
    pageCount: waitResult.pageCount,
    list: waitResult.list,
  };
}

function launchQianfanClientViaCmdStart(config) {
  return spawnQianfanClientViaCmdStart(config);
}

async function waitForDevTools(config) {
  const startedAt = Date.now();
  const probePorts = collectDevToolsProbePorts(config);

  while (Date.now() - startedAt < config.waitTimeoutMs) {
    const probe = await probeDevToolsOnPorts(config, probePorts);
    if (probe.ok) {
      rememberDevToolsProbe(probe);
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
  const probePorts = collectDevToolsProbePorts(config);
  while (Date.now() - started < timeoutMs) {
    const probe = await probeDevToolsOnPorts(config, probePorts);
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
  const launched = await launchQianfanClient(rawConfig, logFn);
  if (!launched.ok) {
    return launched;
  }

  return {
    ...launched,
    processStarted: true,
    devtoolsReady: launched.devtoolsReady === true,
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

  if (config.devtoolsPortAdjusted) {
    log(
      'warn',
      `[千帆] Windows 已将 ${config.devtoolsPortRequested} 划入系统保留端口，自动改用 ${config.devtoolsPort}`,
    );
  } else if (process.platform === 'win32' && isWindowsPortExcluded(config.devtoolsPort)) {
    const suggested = suggestDevToolsPort();
    return {
      ok: false,
      reason: 'port_excluded',
      lastError: buildPortExcludedError(config.devtoolsPort, suggested),
      suggestedPort: suggested,
    };
  }

  const firstProbe = await probeDevToolsOnPorts(config);
  if (firstProbe.ok) {
    log('info', `[千帆] DevTools ${firstProbe.devtoolsPort}：可访问`);
    return {
      ok: true,
      phase: 'attached',
      alreadyRunning: true,
      devtoolsAccessible: true,
      probe: firstProbe,
      pageCount: firstProbe.pageCount,
      list: firstProbe.list,
      devtoolsPort: firstProbe.devtoolsPort,
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

  if (
    !firstProbe.ok
    && isQianfanProcessRunning(config.qianfanClientProcessName)
    && mainProcessHasAnyDebugPortArg(config)
  ) {
    if (!canLaunch) {
      return {
        ok: false,
        reason: 'waiting_launch',
        lastError: '正在等待主进程启动千帆客服工作台…',
      };
    }
    const waited = await waitForDevToolsAttach(config, options, options.log);
    if (waited.ok) {
      log('info', `[千帆] DevTools ${config.devtoolsPort}：可访问`);
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
      reason: 'timeout',
      lastError: `千帆已带调试参数启动，但 DevTools ${config.devtoolsPort} 等待超时。请确认千帆已登录并完成店铺工作台加载`,
    };
  }

  if (!canLaunch) {
    const attachWaitMs = Number(
      options.attachWaitMs || Math.max(config.waitTimeoutMs || 60000, 120000),
    );
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
    const closeResult = await killQianfanClientIfNotInDebugMode(config, {
      log: options.log,
      closeWaitMs: config.closeWaitMs,
      allowKill: canLaunch && options.allowKillNonDebugClient !== false,
    });
    if (!closeResult.killed) {
      if (closeResult.reason === 'debug_mode' && closeResult.probe?.ok) {
        log('info', `[千帆] DevTools ${config.devtoolsPort}：可访问`);
        return {
          ok: true,
          phase: 'attached',
          alreadyRunning: true,
          devtoolsAccessible: true,
          probe: closeResult.probe,
          pageCount: closeResult.probe.pageCount,
          list: closeResult.probe.list,
        };
      }
      if (closeResult.reason === 'auto_close_disabled') {
        return {
          ok: false,
          reason: 'no_debug_port',
          lastError: closeResult.lastError || `千帆已运行但未开启调试端口 ${config.devtoolsPort}，请关闭后重试`,
        };
      }
      if (closeResult.reason === 'stop_incomplete') {
        return {
          ok: false,
          reason: 'stop_incomplete',
          lastError: closeResult.lastError || '千帆进程未能全部退出，请手动关闭后重试',
        };
      }
      if (closeResult.reason === 'debug_launch_pending') {
        const waited = await waitForDevToolsAttach(config, options, options.log);
        if (waited.ok) {
          log('info', `[千帆] DevTools ${config.devtoolsPort}：可访问`);
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
          reason: 'timeout',
          lastError: `千帆已带调试参数启动，但 DevTools ${config.devtoolsPort} 等待超时。请确认千帆已登录并完成店铺工作台加载`,
        };
      }
      if (closeResult.reason === 'runtime_shutting_down') {
        return {
          ok: false,
          reason: 'shutting_down',
          lastError: '软件正在退出，已跳过千帆进程切换',
        };
      }
      if (isQianfanProcessRunning(config.qianfanClientProcessName)) {
        return {
          ok: false,
          reason: 'no_debug_port',
          lastError: `千帆已运行但未开启调试端口 ${config.devtoolsPort}，请手动以调试模式启动`,
        };
      }
    }
  }

  const doLaunch = options.launchFn || ((cfg) => launchQianfanClient(cfg, log));
  const launched = await Promise.resolve(doLaunch(config));
  if (!launched.ok) {
    return {
      ok: false,
      reason: 'launch_failed',
      lastError: launched.error || '千帆启动失败',
    };
  }

  if (launched.probe && launched.devtoolsReady) {
    log('info', `[千帆] DevTools ${config.devtoolsPort} 已就绪`);
    return {
      ok: true,
      phase: 'ready',
      devtoolsAccessible: true,
      launched: true,
      pid: launched.pid || null,
      probe: launched.probe,
      pageCount: launched.pageCount,
      list: launched.list,
    };
  }

  const waitResult = await waitForDevToolsAttach(config, options, options.log);
  if (!waitResult.ok) {
    const lastError = launched.processStarted
      ? `千帆进程已启动，但 DevTools ${config.devtoolsPort} 等待超时。请确认千帆已登录并完成店铺工作台加载`
      : `千帆 DevTools ${config.devtoolsPort} 等待超时，请手动运行：${buildLaunchCommandLine(config)}`;
    return {
      ok: false,
      reason: waitResult.reason || 'timeout',
      lastError,
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
  const clientConfig = resolveClientConfig(config);
  const result = await killQianfanClientIfNotInDebugMode(clientConfig, {
    log: logFn,
    closeWaitMs: clientConfig.closeWaitMs,
    allowKill: true,
  });
  return result.killed === true;
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
  const resolved = resolveClientConfig(config);
  const argText = resolved.qianfanClientArgs.join(' ');
  return [
    '@echo off',
    `cd /d "${resolved.qianfanClientWorkingDir}"`,
    `start "" "${resolved.qianfanClientExePath}" ${argText}`,
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
  isQianfanClientInDebugMode,
  killQianfanClientIfNotInDebugMode,
  isRuntimeShuttingDown,
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
  buildLaunchCommandLine,
  buildCmdStartInner,
  buildCmdStartCommand,
  buildLaunchBatContent,
  writeLaunchBatFile,
  waitForDevTools,
  waitForDevToolsAttach,
  mainProcessHasDebugPortArg,
  buildDefaultClientArgs,
  countQianfanProcesses,
  forceStopQianfanClient,
  DEFAULT_CLIENT_EXE,
  DEFAULT_CLIENT_DIR,
  DEFAULT_CLIENT_PROCESS,
  DEFAULT_DEVTOOLS_PORT,
};
