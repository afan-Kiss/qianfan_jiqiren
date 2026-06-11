const { execSync } = require('child_process');

const DEFAULT_DEVTOOLS_PORT = 9322;
const LEGACY_DEVTOOLS_PORT = 9223;
const FALLBACK_DEVTOOLS_PORTS = [9322, 19222, 9333, 19223];

let cachedRanges = null;

function loadExcludedTcpPortRanges() {
  if (cachedRanges) return cachedRanges;
  if (process.platform !== 'win32') {
    cachedRanges = [];
    return cachedRanges;
  }
  try {
    const output = execSync('netsh interface ipv4 show excludedportrange protocol=tcp', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const ranges = [];
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)/);
      if (match) {
        ranges.push({ start: Number(match[1]), end: Number(match[2]) });
      }
    }
    cachedRanges = ranges;
    return ranges;
  } catch {
    cachedRanges = [];
    return cachedRanges;
  }
}

function isWindowsPortExcluded(port) {
  const value = Number(port);
  if (!Number.isFinite(value) || value <= 0) return false;
  return loadExcludedTcpPortRanges().some((range) => value >= range.start && value <= range.end);
}

function suggestDevToolsPort(preferredPort = DEFAULT_DEVTOOLS_PORT) {
  if (!isWindowsPortExcluded(preferredPort)) return preferredPort;
  for (const port of FALLBACK_DEVTOOLS_PORTS) {
    if (!isWindowsPortExcluded(port)) return port;
  }
  return preferredPort;
}

function buildPortExcludedError(port, suggestedPort = DEFAULT_DEVTOOLS_PORT) {
  return `DevTools 端口 ${port} 在 Windows 系统保留段内无法绑定（常见于 Hyper-V/WSL 占用 9222-9321）。请将 config.wxbot-new.json 的 devtoolsPort 改为 ${suggestedPort} 后重试`;
}

function resolveDevToolsPort(requestedPort) {
  const port = Number(requestedPort || DEFAULT_DEVTOOLS_PORT);
  if (process.platform !== 'win32' || !isWindowsPortExcluded(port)) {
    return { port, adjusted: false, requestedPort: port };
  }
  const suggested = suggestDevToolsPort(DEFAULT_DEVTOOLS_PORT);
  return {
    port: suggested,
    adjusted: suggested !== port,
    requestedPort: port,
    suggestedPort: suggested,
  };
}

module.exports = {
  DEFAULT_DEVTOOLS_PORT,
  LEGACY_DEVTOOLS_PORT,
  FALLBACK_DEVTOOLS_PORTS,
  loadExcludedTcpPortRanges,
  isWindowsPortExcluded,
  suggestDevToolsPort,
  buildPortExcludedError,
  resolveDevToolsPort,
};
