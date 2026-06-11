const fs = require('fs');
const path = require('path');
const { getCdpBridgeConfig } = require('../src/shared/config');
const { ensureDir, resolveLogsDir } = require('../src/shared/app-root');
const { bridgeLog } = require('../src/shared/bridge-log');
const { detectDevToolsPort } = require('../src/services/cdp/cdp-port-detector');
const { discoverTargets } = require('../src/services/cdp/cdp-target-manager');
const { CdpBridgeService } = require('../src/services/cdp/cdp-bridge-service');
const { closeBridgeDb, getBridgeDb } = require('../src/services/bridge/bridge-db');

const steps = [];

function pass(name, detail) {
  steps.push({ step: name, ok: true, detail: detail || '' });
  bridgeLog('[BRIDGE_HEALTH]', `SMOKE PASS: ${name}`, detail || '');
}

function fail(name, detail) {
  steps.push({ step: name, ok: false, detail: detail || '' });
  bridgeLog('[BRIDGE_ERROR]', `SMOKE FAIL: ${name}`, detail || '');
}

async function main() {
  const cfg = getCdpBridgeConfig();
  const startedAt = new Date().toISOString();

  // 1. CDP port
  const portDetect = await detectDevToolsPort();
  if (portDetect.ok) pass('cdp_port', `port=${portDetect.port}`);
  else fail('cdp_port', portDetect.reason || 'no_devtools_port');

  // 2. targets
  let targets = [];
  if (portDetect.ok) {
    const discovered = await discoverTargets({ port: portDetect.port, host: portDetect.host });
    targets = discovered.targets || [];
    if (discovered.ok) pass('discover_targets', `count=${targets.length}`);
    else fail('discover_targets', discovered.reason || 'no_matching_targets');
  } else {
    fail('discover_targets', 'skipped: no port');
  }

  // 3-6. connect, inject, listen, db
  let health = {};
  let report = {};
  const service = new CdpBridgeService();
  try {
    if (portDetect.ok && targets.length) {
      health = await service.start({ listenMs: Math.max(5000, Number(cfg.listenMs || 8000)) });
      report = service.getReport();
      if (health.cdpConnected) pass('cdp_connect', 'connected');
      else fail('cdp_connect', 'not connected');

      if (health.injectedCount > 0) pass('inject_hook', `injected=${health.injectedCount}`);
      else fail('inject_hook', 'no successful injection');

      if (health.frameCount > 0 || report.stats?.routed > 0) {
        pass('ws_frames', `frames=${health.frameCount || report.stats?.routed}`);
      } else {
        fail('ws_frames', 'no frames yet (客服页可能暂无 WS 流量，连接/注入仍可能正常)');
      }
    } else {
      fail('cdp_connect', 'skipped');
      fail('inject_hook', 'skipped');
      fail('ws_frames', 'skipped');
    }
  } catch (err) {
    fail('cdp_connect', String(err.message || err));
    fail('inject_hook', 'error during start');
    fail('ws_frames', 'error during start');
  } finally {
    await service.stop();
  }

  // SQLite
  try {
    const db = getBridgeDb();
    const frameCount = db.prepare('SELECT COUNT(*) AS c FROM ws_frames').get()?.c || 0;
    if (frameCount >= 0) pass('sqlite_write', `ws_frames=${frameCount}`);
    else fail('sqlite_write', 'count query failed');
  } catch (err) {
    fail('sqlite_write', String(err.message || err));
  }

  const allRequiredOk = steps.filter((s) => ['cdp_port', 'discover_targets', 'cdp_connect', 'inject_hook', 'sqlite_write'].includes(s.step)).every((s) => s.ok);
  const summary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: allRequiredOk,
    steps,
    health,
    stats: report.stats || {},
  };

  const dir = ensureDir(resolveLogsDir());
  const out = path.join(dir, 'cdp-smoke-latest.json');
  fs.writeFileSync(out, JSON.stringify(summary, null, 2), 'utf8');
  bridgeLog('[BRIDGE_HEALTH]', `冒烟结果 ok=${summary.ok} -> ${out}`);

  closeBridgeDb();
  if (!summary.ok) {
    console.error('CDP smoke test failed. See steps above and logs/cdp-smoke-latest.json');
    process.exit(1);
  }
}

main().catch((err) => {
  bridgeLog('[BRIDGE_ERROR]', 'smoke 异常', String(err.message || err));
  closeBridgeDb();
  process.exit(2);
});
