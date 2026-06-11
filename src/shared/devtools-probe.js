const { getDoudianConfig } = require('./config');
const { println } = require('./logger');

async function fetchDevToolsJsonList(port, host = '127.0.0.1') {
  const url = `http://${host}:${port}/json/list`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`DevTools ${host}:${port} HTTP ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error(`DevTools ${host}:${port} 返回格式异常`);
  return list;
}

async function probeDevToolsPort(port, host = '127.0.0.1') {
  try {
    const versionRes = await fetch(`http://${host}:${port}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!versionRes.ok) {
      return { ok: false, port, host, reason: `HTTP ${versionRes.status}` };
    }
    const version = await versionRes.json();
    const browser = String(version?.Browser || '');
    if (/node\.js/i.test(browser)) {
      return { ok: false, port, host, reason: 'not_chromium_devtools', browser };
    }
    const list = await fetchDevToolsJsonList(port, host);
    const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    return {
      ok: true,
      port,
      host,
      browser,
      pageCount: pages.length,
      list,
      pages,
    };
  } catch (err) {
    return { ok: false, port, host, reason: String(err.message || err) };
  }
}

async function scanDevToolsPorts(ports, host) {
  const results = [];
  for (const port of ports) {
    const probe = await probeDevToolsPort(port, host);
    results.push(probe);
    if (probe.ok) {
      println(`DevTools 端口 ${host}:${port} 可用，页面数=${probe.pageCount}`);
    }
  }
  return results;
}

async function findActiveDevToolsPort(options = {}) {
  const cfg = getDoudianConfig();
  const host = options.host || cfg.devtoolsHost || '127.0.0.1';
  const ports = options.ports || cfg.devtoolsPorts || [19528, 9222];
  const probes = await scanDevToolsPorts(ports, host);
  const active = probes.filter((p) => p.ok);

  let best = null;
  if (options.preferDoudianPages && active.length) {
    const { findDoudianPages } = require('../platforms/doudian/doudian-page-finder');
    for (const probe of active) {
      const report = findDoudianPages(probe.pages || probe.list || [], { devtoolsPort: probe.port });
      if (report.servicePageCount > 0 || report.relatedPageCount > 0) {
        best = { ...probe, doudianReport: report };
        break;
      }
    }
  }

  if (!best) {
    best = active.sort((a, b) => b.pageCount - a.pageCount)[0] || null;
  }

  return {
    probes,
    active,
    best,
  };
}

function getPageTargets(list) {
  return (Array.isArray(list) ? list : []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

module.exports = {
  fetchDevToolsJsonList,
  probeDevToolsPort,
  scanDevToolsPorts,
  findActiveDevToolsPort,
  getPageTargets,
};
