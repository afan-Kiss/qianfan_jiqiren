const { execSync } = require('child_process');
const net = require('net');
const path = require('path');
const { resolveProjectRoot } = require('./app-root');
const { shouldProtectLiveLockPid } = require('../platforms/doudian/doudian-run-lock');

const SENSITIVE_RE =
  /cookie|authorization|token|csrf|x-ms-token|bd-ticket|x-tt-session-sign|sessionid|api[_-]?key/i;
const DEFAULT_ALLOWLIST = ['node.exe'];
const BLOCKED_PROCESS_RE = /doudian|electron|system|svchost|csrss|lsass|services/i;

function redactCommandLine(commandLine = '') {
  let out = String(commandLine || '');
  if (SENSITIVE_RE.test(out)) return '[redacted-command-line]';
  if (out.length > 240) return `${out.slice(0, 240)}...[truncated]`;
  return out;
}

function normalizePathForMatch(value = '') {
  return String(value || '').replace(/\\/g, '/').toLowerCase();
}

function stripPowerShellOutput(raw = '') {
  const text = String(raw || '');
  const withoutXml = text.replace(/#< CLIXML[\s\S]*?<\/Objs>\s*/i, '').trim();
  const lines = withoutXml
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : withoutXml;
}

function runPowerShell(script) {
  const normalized = String(script || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  const withProgress = `$ProgressPreference = 'SilentlyContinue'; ${normalized}`;
  const encoded = Buffer.from(withProgress, 'utf16le').toString('base64');
  const out = execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    windowsHide: true,
  });
  return stripPowerShellOutput(out);
}

function runPowerShellJson(script) {
  try {
    const out = runPowerShell(script);
    const trimmed = String(out || '').trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function getWindowsListenOwners(port, host = '127.0.0.1') {
  const script = `$rows = Get-NetTCPConnection -LocalPort ${Number(
    port
  )} -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '${host}' -or $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' } | Select-Object -ExpandProperty OwningProcess -Unique; if (-not $rows) { '[]' } else { $rows | ConvertTo-Json }`;
  const data = runPowerShellJson(script);
  if (!data) return [];
  return (Array.isArray(data) ? data : [data])
    .map((pid) => Number(pid))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

function getProcessInfo(pid) {
  if (process.platform !== 'win32') {
    return {
      pid,
      processName: 'node.exe',
      commandLine: '',
    };
  }
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(
    pid
  )}" -ErrorAction SilentlyContinue; if (-not $p) { '{}' } else { @{ ProcessId = $p.ProcessId; Name = $p.Name; CommandLine = $p.CommandLine } | ConvertTo-Json -Compress }`;
  const data = runPowerShellJson(script);
  if (!data || !data.ProcessId) {
    try {
      const name = runPowerShell(
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`
      ).trim();
      return { pid, processName: name ? `${name}.exe` : '', commandLine: '' };
    } catch {
      return { pid, processName: '', commandLine: '' };
    }
  }
  const processName = String(data.Name || '').toLowerCase().endsWith('.exe')
    ? String(data.Name)
    : data.Name
      ? `${data.Name}.exe`
      : '';
  return {
    pid: Number(data.ProcessId),
    processName,
    commandLine: String(data.CommandLine || ''),
  };
}

function isPortInUse(host, port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', (err) => resolve(err && err.code === 'EADDRINUSE'));
    tester.once('listening', () => {
      tester.close(() => resolve(false));
    });
    tester.listen(port, host);
  });
}

async function waitPortFree(host, port, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const occupied = await isPortInUse(host, port);
    if (!occupied) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function isSafeToKill(processInfo = {}, options = {}) {
  const allowList = (options.processNameAllowList || DEFAULT_ALLOWLIST).map((n) =>
    String(n).toLowerCase()
  );
  const processName = String(processInfo.processName || '').toLowerCase();
  if (!processName || !allowList.includes(processName)) {
    return { ok: false, reason: 'process_not_in_allowlist' };
  }
  if (BLOCKED_PROCESS_RE.test(processName)) {
    return { ok: false, reason: 'blocked_process_name' };
  }
  if (processInfo.pid === process.pid) {
    return { ok: false, reason: 'same_process_pid' };
  }

  const projectRoot = normalizePathForMatch(resolveProjectRoot());
  const cmd = normalizePathForMatch(processInfo.commandLine || '');
  const projectMarkers = [
    projectRoot,
    'doudian-bot',
    'doudian-ws-server',
    'doudian-verify',
    'doudian-fill',
    'auto-verify-doudian',
    'scripts/',
    'scripts\\',
    'test-port-guard-holder',
    'src/platforms/doudian',
    'src\\platforms\\doudian',
  ];
  const matched = projectMarkers.some((m) => cmd.includes(normalizePathForMatch(m)));
  if (!matched) {
    return { ok: false, reason: 'command_line_not_project' };
  }
  return { ok: true, reason: '' };
}

function killProcess(pid) {
  if (process.platform === 'win32') {
    execSync(`taskkill /PID ${pid} /F`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      windowsHide: true,
    });
    return true;
  }
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

async function ensurePortAvailable(options = {}) {
  const port = Number(options.port || 19527);
  const host = options.host || '127.0.0.1';
  const forceKill = !!options.forceKill;
  const killExisting =
    options.killExisting !== undefined ? options.killExisting !== false : true;
  const respectLiveLock = options.respectLiveLock !== false;
  const timeoutMs = Number(options.timeoutMs || 10000);
  const result = {
    port,
    host,
    wasOccupied: false,
    killedPids: [],
    skippedPids: [],
    success: true,
    reason: '',
    attempts: [],
  };

  const occupied = await isPortInUse(host, port);
  if (!occupied) {
    result.reason = 'port_free';
    return result;
  }
  result.wasOccupied = true;

  if (!killExisting) {
    result.success = false;
    result.reason = 'port_occupied_kill_disabled';
    return result;
  }

  const owners =
    process.platform === 'win32' ? getWindowsListenOwners(port, host) : [process.pid];
  if (!owners.length) {
    result.success = false;
    result.reason = 'port_occupied_owner_unknown';
    return result;
  }

  for (const pid of owners) {
    const info = getProcessInfo(pid);
    const safety = isSafeToKill(info, options);
    const attempt = {
      pid,
      processName: info.processName || '',
      commandLine: redactCommandLine(info.commandLine),
      action: safety.ok ? 'kill' : 'skip',
      reason: safety.reason || '',
    };
    result.attempts.push(attempt);

    if (!safety.ok) {
      result.skippedPids.push(pid);
      console.log(
        `[port-guard] 跳过 pid=${pid} process=${info.processName || ''} reason=${safety.reason}`
      );
      console.log(`[port-guard] commandLine=${attempt.commandLine}`);
      continue;
    }

    if (respectLiveLock && shouldProtectLiveLockPid(pid, { forceKill, lockPath: options.lockPath })) {
      result.skippedPids.push(pid);
      attempt.action = 'skip';
      attempt.reason = 'another_doudian_task_running';
      console.log(
        `[port-guard] 跳过 pid=${pid} process=${info.processName || ''} reason=another_doudian_task_running`
      );
      console.log(`[port-guard] commandLine=${attempt.commandLine}`);
      continue;
    }

    console.log(
      `[port-guard] 释放端口 ${host}:${port} -> 结束 pid=${pid} process=${info.processName}`
    );
    console.log(`[port-guard] commandLine=${attempt.commandLine}`);
    try {
      killProcess(pid);
      result.killedPids.push(pid);
    } catch (err) {
      result.skippedPids.push(pid);
      attempt.action = 'kill_failed';
      attempt.reason = err.message || 'kill_failed';
    }
  }

  if (result.killedPids.length === 0 && result.skippedPids.length > 0) {
    const liveTaskBlocked = result.attempts.some(
      (a) => a.reason === 'another_doudian_task_running'
    );
    result.success = false;
    result.reason = liveTaskBlocked
      ? 'another_doudian_task_running'
      : 'port_occupied_by_unknown_process';
    return result;
  }

  const freed = await waitPortFree(host, port, timeoutMs);
  if (!freed) {
    result.success = false;
    result.reason = 'port_still_occupied_after_kill';
    return result;
  }

  result.reason = result.killedPids.length ? 'port_released_after_kill' : 'port_free';
  return result;
}

module.exports = {
  ensurePortAvailable,
  isPortInUse,
  waitPortFree,
  getWindowsListenOwners,
  getProcessInfo,
  isSafeToKill,
  redactCommandLine,
  DEFAULT_ALLOWLIST,
};
