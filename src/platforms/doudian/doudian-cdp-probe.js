const { getDoudianConfig } = require('../../shared/config');
const { println } = require('../../shared/logger');
const { fetchDevToolsJsonList, probeDevToolsPort } = require('../../shared/devtools-probe');
const { findDoudianPages, isPriorityServiceUrl } = require('./doudian-page-finder');

const BASE_PORTS = [9222, 9223, 9333, 4723];
const RANGE_START = 10000;
const RANGE_END = 10100;

function buildCdpPortList(extraPorts = []) {
  const cfg = getDoudianConfig();
  const fromConfig = Array.isArray(cfg.devtoolsPorts) ? cfg.devtoolsPorts : [];
  const rangePorts = [];
  for (let p = RANGE_START; p <= RANGE_END; p += 1) rangePorts.push(p);
  const merged = [...fromConfig, ...extraPorts, ...BASE_PORTS, ...rangePorts];
  const seen = new Set();
  const out = [];
  for (const port of merged) {
    const n = Number(port);
    if (!Number.isFinite(n) || n <= 0 || n > 65535 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

async function scanCdpPorts(options = {}) {
  const cfg = getDoudianConfig();
  const host = options.host || cfg.devtoolsHost || '127.0.0.1';
  const ports = options.ports || buildCdpPortList();
  println('CDP 探测开始');
  println(`扫描端口 ${ports.length} 个（含 ${RANGE_START}-${RANGE_END}）`);

  const probes = [];
  let scanned = 0;
  for (const port of ports) {
    scanned += 1;
    const probe = await probeDevToolsPort(port, host);
    probes.push(probe);
    if (probe.ok) {
      println(`CDP 端口可用 ${host}:${port} pages=${probe.pageCount} browser=${probe.browser || ''}`);
    }
    if (options.stopOnFirstDoudian && probe.ok) {
      const report = findDoudianPages(probe.pages || probe.list || [], { devtoolsPort: port });
      if (report.priorityServicePage) {
        println(`CDP 发现抖店客服页 port=${port} url=${report.priorityServicePage.url}`);
        return { probes, active: probes.filter((p) => p.ok), best: { ...probe, doudianReport: report }, scanned };
      }
    }
  }

  const active = probes.filter((p) => p.ok);
  let best = null;

  for (const probe of active) {
    const report = findDoudianPages(probe.pages || probe.list || [], { devtoolsPort: probe.port });
    if (report.priorityServicePage || report.servicePageCount > 0) {
      best = { ...probe, doudianReport: report };
      println(`CDP 命中抖店页面 port=${probe.port} service=${report.servicePageCount}`);
      break;
    }
  }

  if (!best && active.length) {
    best = active.sort((a, b) => b.pageCount - a.pageCount)[0];
    println(`CDP 未发现抖店客服页，仅记录可用端口 ${best.port}`);
  }

  if (!active.length) {
    println('未发现 DevTools 监听端口');
  }

  return { probes, active, best, scanned, cdpAvailable: active.length > 0 };
}

async function probeCdpRoute(options = {}) {
  const scan = await scanCdpPorts(options);
  const canInject =
    Boolean(scan.best?.doudianReport?.priorityServicePage || scan.best?.doudianReport?.bestServicePage);

  return {
    route: 'cdp',
    available: scan.cdpAvailable,
    canInject,
    scan,
    reason: scan.cdpAvailable
      ? canInject
        ? 'cdp_ready'
        : 'cdp_no_doudian_page'
      : 'cdp_port_unreachable',
  };
}

module.exports = {
  BASE_PORTS,
  RANGE_START,
  RANGE_END,
  buildCdpPortList,
  scanCdpPorts,
  probeCdpRoute,
  fetchDevToolsJsonList,
};
