const { getCdpBridgeConfig } = require('../../shared/config');
const { bridgeLog } = require('../../shared/bridge-log');
const { probeDevToolsPort, scanDevToolsPorts } = require('../../shared/devtools-probe');

async function detectDevToolsPort(options = {}) {
  const cfg = getCdpBridgeConfig();
  const host = options.host || cfg.devtoolsHost || '127.0.0.1';
  const ports = options.ports || cfg.ports || [9222, 9223, 9224];
  bridgeLog('[CDP_PORT]', `开始检测 DevTools 端口 host=${host} ports=${ports.join(',')}`);

  const probes = await scanDevToolsPorts(ports, host);
  const active = probes.filter((p) => p.ok);

  if (!active.length) {
    for (const p of probes) {
      bridgeLog('[CDP_PORT]', `端口不可用 ${host}:${p.port} reason=${p.reason || 'unknown'}`);
    }
    return {
      ok: false,
      host,
      ports,
      probes,
      active: [],
      reason: 'no_devtools_port',
      webSocketDebuggerUrl: '',
      browserVersion: '',
    };
  }

  let best = active.sort((a, b) => b.pageCount - a.pageCount)[0];
  let version = {};
  try {
    const res = await fetch(`http://${host}:${best.port}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    version = await res.json();
  } catch (err) {
    bridgeLog('[CDP_PORT]', '读取 /json/version 失败', String(err.message || err));
  }

  const webSocketDebuggerUrl = String(version.webSocketDebuggerUrl || '');
  bridgeLog('[CDP_PORT]', `可用端口 ${host}:${best.port} pages=${best.pageCount} browser=${version.Browser || ''}`);

  return {
    ok: true,
    host,
    port: best.port,
    probes,
    active,
    webSocketDebuggerUrl,
    browserVersion: String(version.Browser || ''),
    userAgent: String(version['User-Agent'] || ''),
    reason: 'devtools_port_found',
  };
}

async function probeSinglePort(port, host) {
  return probeDevToolsPort(port, host);
}

module.exports = {
  detectDevToolsPort,
  probeSinglePort,
};
