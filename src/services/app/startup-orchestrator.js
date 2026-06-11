const { getCdpBridgeConfig, getHistorySyncConfig } = require('../shared/config');
const { ensureDebugClientReady } = require('../services/runtime/ensure-debug-client-ready');
const { HistorySyncManager } = require('../services/history/history-sync-manager');
const { CdpBridgeService } = require('../services/cdp/cdp-bridge-service');
const { historyLog } = require('../shared/history-log');
const { bridgeLog } = require('../shared/bridge-log');

async function runStartupOrchestrator(options = {}) {
  const historyCfg = getHistorySyncConfig();
  const cdpCfg = getCdpBridgeConfig();

  const result = {
    clientRuntime: null,
    historySync: null,
    cdpBridge: null,
    startedAt: new Date().toISOString(),
    finishedAt: '',
  };

  result.clientRuntime = await ensureDebugClientReady(options);

  if (historyCfg.enabled && historyCfg.runOnStartup !== false && options.runHistorySync !== false) {
    historyLog('[HISTORY_SYNC]', 'startup history sync');
    const manager = new HistorySyncManager();
    result.historySync = await manager.runSync({ listenMs: options.historyListenMs || 12000 });
  }

  if (cdpCfg.enabled && result.clientRuntime.ready && options.runCdpBridge !== false) {
    bridgeLog('[CDP_RUNTIME]', 'startup CDP bridge');
    const bridge = new CdpBridgeService();
    try {
      result.cdpBridge = await bridge.start({ listenMs: Number(options.cdpListenMs || 0) });
      if (Number(options.cdpListenMs || 0) > 0) {
        await bridge.stop();
      }
    } catch (err) {
      result.cdpBridge = { error: String(err.message || err) };
    }
  }

  result.finishedAt = new Date().toISOString();
  return result;
}

module.exports = {
  runStartupOrchestrator,
};
