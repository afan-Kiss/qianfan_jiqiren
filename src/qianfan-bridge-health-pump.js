const {
  listRegisteredShops,
  findBridgeByShopTitle,
  isBridgeCdpReady,
  probePageImpaasWs,
  getBridgeWsActivity,
  normalizeShopKey,
  refreshBridgeNetwork,
  triggerShopReconnect,
} = require('./qianfan-ws-bridge');

const PROBE_MS = Number(process.env.QIANFAN_BRIDGE_HEALTH_MS || 30000);
const WS_FRAME_STALE_MS = Number(process.env.QIANFAN_WS_FRAME_STALE_MS || 120000);
const FAIL_THRESHOLD = Number(process.env.QIANFAN_BRIDGE_HEALTH_FAIL_THRESHOLD || 3);

const shopFailCounts = new Map();
const degradedShops = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isShopQianfanDegraded(shopTitle) {
  const key = normalizeShopKey(shopTitle);
  return key ? degradedShops.has(key) : false;
}

function getShopDegradedReason(shopTitle) {
  return degradedShops.get(normalizeShopKey(shopTitle)) || null;
}

function setShopDegraded(shopTitle, reason) {
  const key = normalizeShopKey(shopTitle);
  if (!key) return;
  degradedShops.set(key, { reason: String(reason || 'health_fail'), at: Date.now() });
}

function clearShopDegraded(shopTitle) {
  const key = normalizeShopKey(shopTitle);
  if (!key) return;
  degradedShops.delete(key);
  shopFailCounts.delete(key);
}

async function probeShopHealth(shopTitle) {
  const bridge = findBridgeByShopTitle(shopTitle);
  const issues = [];

  if (!bridge || !isBridgeCdpReady(bridge)) {
    issues.push('cdp_not_ready');
    return { ok: false, issues, wsProbe: { ok: false, count: 0 }, activity: null };
  }

  const wsProbe = await probePageImpaasWs(bridge);
  if (!wsProbe.ok || wsProbe.count <= 0) {
    issues.push('ws_not_open');
  }

  const activity = getBridgeWsActivity(shopTitle);
  const lastFrame = Math.max(activity.lastWsFrameAt || 0, activity.lastActivityAt || 0);
  if (lastFrame > 0 && Date.now() - lastFrame > WS_FRAME_STALE_MS) {
    issues.push('ws_frame_stale');
  }

  return { ok: issues.length === 0, issues, wsProbe, activity };
}

async function recoverShopHealth(shopTitle, bridge) {
  if (bridge?.client) {
    await refreshBridgeNetwork(bridge.client);
  }
  await triggerShopReconnect(shopTitle, 'health_pump');
  await sleep(3000);
}

async function runHealthProbeCycle(logFn = () => {}) {
  const shops = listRegisteredShops();
  const summary = { shops: shops.length, degraded: 0, recovered: 0, failed: 0 };

  for (const shopTitle of shops) {
    const key = normalizeShopKey(shopTitle);
    try {
      const result = await probeShopHealth(shopTitle);
      if (result.ok) {
        if (degradedShops.has(key)) {
          summary.recovered += 1;
          logFn('info', `qianfan health recovered shop=${shopTitle}`);
        }
        clearShopDegraded(shopTitle);
        continue;
      }

      const fails = (shopFailCounts.get(key) || 0) + 1;
      shopFailCounts.set(key, fails);
      summary.failed += 1;
      logFn(
        'warn',
        `qianfan health fail shop=${shopTitle} streak=${fails} issues=${result.issues.join(',')}`,
      );

      if (fails >= 2 && fails < FAIL_THRESHOLD) {
        const bridge = findBridgeByShopTitle(shopTitle);
        await recoverShopHealth(shopTitle, bridge);
        const after = await probeShopHealth(shopTitle);
        if (after.ok) {
          clearShopDegraded(shopTitle);
          summary.recovered += 1;
          logFn('info', `qianfan health ok after reconnect shop=${shopTitle}`);
          continue;
        }
      }

      if (fails >= FAIL_THRESHOLD) {
        setShopDegraded(shopTitle, result.issues.join(','));
        summary.degraded += 1;
        logFn('error', `qianfan shop degraded shop=${shopTitle} reason=${result.issues.join(',')}`);
      }
    } catch (err) {
      summary.failed += 1;
      logFn('error', `qianfan health probe error shop=${shopTitle}: ${err.message || err}`);
    }
  }

  return summary;
}

function createQianfanBridgeHealthPump(options = {}) {
  const logFn = typeof options.log === 'function' ? options.log : () => {};
  let timer = null;

  function start() {
    stop();
    timer = setInterval(() => {
      void runHealthProbeCycle(logFn);
    }, PROBE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    void runHealthProbeCycle(logFn);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    runOnce: () => runHealthProbeCycle(logFn),
    isShopQianfanDegraded,
    getShopDegradedReason,
    getDegradedShops: () => [...degradedShops.entries()],
  };
}

module.exports = {
  createQianfanBridgeHealthPump,
  isShopQianfanDegraded,
  getShopDegradedReason,
  runHealthProbeCycle,
  PROBE_MS,
  FAIL_THRESHOLD,
};
