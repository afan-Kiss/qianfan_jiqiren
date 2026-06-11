const path = require('path');
const { spawn } = require('child_process');
const { getClientRuntimeConfig, getDoudianConfig, getCdpBridgeConfig } = require('../../shared/config');
const { historyLog } = require('../../shared/history-log');
const { detectDevToolsPort } = require('../cdp/cdp-port-detector');
const { discoverTargets } = require('../cdp/cdp-target-manager');
const { detectDoudianProcesses } = require('../../platforms/doudian/doudian-process-detector');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findClientExe(installDir) {
  const candidates = ['抖店工作台.exe', '抖店.exe', 'DouDian.exe', 'doudian.exe'];
  for (const name of candidates) {
    const full = path.join(installDir, name);
    try {
      const fs = require('fs');
      if (fs.existsSync(full)) return full;
    } catch {
      // ignore
    }
  }
  return '';
}

async function waitForDevtoolsPort(host, ports, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const portDetect = await detectDevToolsPort({ host, ports });
    if (portDetect.ok) return portDetect;
    await sleep(1000);
  }
  return detectDevToolsPort({ host, ports });
}

async function tryLaunchClient(cfg, runtimeCfg, debugPort) {
  const installDir = cfg.installDir || cfg.testInstallDir || cfg.originalInstallDir;
  if (!installDir) {
    return { ok: false, reason: 'install_dir_missing' };
  }
  const exe = findClientExe(installDir);
  if (!exe) {
    return { ok: false, reason: 'client_exe_not_found', installDir };
  }
  historyLog('[CDP_LAUNCH]', `devtools unavailable and autoLaunch enabled, launching client port=${debugPort}`);
  try {
    const child = spawn(exe, [`--remote-debugging-port=${debugPort}`], {
      detached: true,
      stdio: 'ignore',
      cwd: installDir,
      windowsHide: false,
    });
    child.unref();
    return { ok: true, reason: 'client_launched', pid: child.pid, exe };
  } catch (err) {
    return { ok: false, reason: 'client_launch_failed', error: String(err.message || err) };
  }
}

async function tryKillExisting(cfg, runtimeCfg) {
  if (!runtimeCfg.killExistingBeforeLaunch) {
    historyLog('[CDP_BLOCK]', 'killExistingBeforeLaunch=false, skip taskkill');
    return { killed: false, reason: 'kill_disabled' };
  }
  historyLog('[CDP_LAUNCH]', 'killExistingBeforeLaunch=true, attempting taskkill');
  const { execSync } = require('child_process');
  const names = cfg.processNames || [];
  let killed = false;
  for (const name of names) {
    try {
      execSync(`taskkill /F /IM ${name}`, { stdio: 'ignore', timeout: 10000 });
      killed = true;
    } catch {
      // ignore
    }
  }
  return { killed, reason: killed ? 'processes_killed' : 'no_process_killed' };
}

async function ensureDebugClientReady(options = {}) {
  const runtimeCfg = { ...getClientRuntimeConfig(), ...(options.clientRuntime || {}) };
  const doudianCfg = getDoudianConfig();
  const cdpCfg = getCdpBridgeConfig();
  const host = options.host || cdpCfg.devtoolsHost || '127.0.0.1';
  const ports = options.ports || cdpCfg.ports || [9222, 9223, 9224];
  const debugPort = Number(options.debugPort || ports[0] || 9222);

  historyLog('[CDP_RUNTIME]', 'ensureDebugClientReady start');

  const processReport = detectDoudianProcesses();
  const clientRunning = processReport.found;

  let portDetect = await detectDevToolsPort({ host, ports });
  let reusedExistingClient = false;
  let killedExistingClient = false;
  let relaunchedClient = false;

  if (portDetect.ok) {
    reusedExistingClient = clientRunning;
    historyLog('[CDP_REUSE]', 'devtools port available, skip relaunch');
    if (clientRunning) {
      historyLog('[CDP_REUSE]', 'existing client detected, devtools ready, reuse current window');
    }
  } else if (clientRunning) {
    if (!runtimeCfg.restartWhenCdpUnavailable) {
      historyLog(
        '[CDP_BLOCK]',
        'client running but devtools unavailable, restart disabled, please start with debug mode'
      );
      return {
        ready: false,
        reusedExistingClient: false,
        killedExistingClient: false,
        relaunchedClient: false,
        devtoolsPort: null,
        versionUrl: null,
        targetCount: 0,
        matchedTargets: [],
        processDetected: true,
        processCount: processReport.count,
        reason: 'devtools_unavailable_restart_disabled',
        message:
          '当前客服台可能不是调试模式启动。请用 --remote-debugging-port=9222 启动后再运行。本次未关闭客服台，未重新打开客服台。',
        portDetect,
      };
    }

    if (runtimeCfg.killExistingBeforeLaunch) {
      const killResult = await tryKillExisting(doudianCfg, runtimeCfg);
      killedExistingClient = killResult.killed;
    }

    if (runtimeCfg.autoLaunchWhenNotRunning || runtimeCfg.restartWhenCdpUnavailable) {
      const launch = await tryLaunchClient(doudianCfg, runtimeCfg, debugPort);
      if (launch.ok) {
        relaunchedClient = true;
        portDetect = await waitForDevtoolsPort(host, ports, runtimeCfg.waitForDevtoolsMs || 15000);
      }
    }
  } else {
    if (!runtimeCfg.autoLaunchWhenNotRunning) {
      historyLog('[CDP_BLOCK]', 'client not running and autoLaunch disabled');
      return {
        ready: false,
        reusedExistingClient: false,
        killedExistingClient: false,
        relaunchedClient: false,
        devtoolsPort: null,
        versionUrl: null,
        targetCount: 0,
        matchedTargets: [],
        processDetected: false,
        processCount: 0,
        reason: 'client_not_running_auto_launch_disabled',
        message: '客服台未运行，且 autoLaunchWhenNotRunning=false，未启动新客户端。',
        portDetect,
      };
    }

    const launch = await tryLaunchClient(doudianCfg, runtimeCfg, debugPort);
    if (launch.ok) {
      relaunchedClient = true;
      portDetect = await waitForDevtoolsPort(host, ports, runtimeCfg.waitForDevtoolsMs || 15000);
    }
  }

  if (!portDetect.ok) {
    return {
      ready: false,
      reusedExistingClient,
      killedExistingClient,
      relaunchedClient,
      devtoolsPort: null,
      versionUrl: null,
      targetCount: 0,
      matchedTargets: [],
      processDetected: clientRunning,
      processCount: processReport.count,
      reason: portDetect.reason || 'no_devtools_port',
      message:
        '当前客服台可能不是调试模式启动。请用调试模式启动后再运行。本次未关闭客服台，未重新打开客服台。',
      portDetect,
    };
  }

  const versionUrl = `http://${host}:${portDetect.port}/json/version`;
  const targetDiscover = await discoverTargets({ port: portDetect.port, host });
  const matchedTargets = targetDiscover.targets || [];

  if (matchedTargets.length) {
    historyLog('[CDP_REUSE]', 'target found, skip taskkill');
  }

  const ready = matchedTargets.length > 0;
  return {
    ready,
    reusedExistingClient: reusedExistingClient || (portDetect.ok && !relaunchedClient),
    killedExistingClient,
    relaunchedClient,
    devtoolsPort: portDetect.port,
    versionUrl,
    listUrl: `http://${host}:${portDetect.port}/json/list`,
    targetCount: matchedTargets.length,
    matchedTargets,
    allTargets: targetDiscover.allTargets || [],
    processDetected: clientRunning || relaunchedClient,
    processCount: processReport.count,
    reason: ready ? 'ready' : 'no_matching_targets',
    message: ready
      ? 'DevTools 可用，已复用现有窗口。'
      : 'DevTools 端口可用但未匹配客服页，请打开 IM/客服窗口。',
    portDetect,
    targetDiscover,
  };
}

module.exports = {
  ensureDebugClientReady,
};
