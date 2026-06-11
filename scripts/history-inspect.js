const { HistorySyncManager } = require('../src/services/history/history-sync-manager');
const { closeHistoryDb } = require('../src/services/history/history-db');
const { historyLog } = require('../src/shared/history-log');

async function main() {
  historyLog('[HISTORY_SYNC]', 'history:inspect start');
  const manager = new HistorySyncManager();
  const report = await manager.runInspect();
  historyLog('[HISTORY_SYNC]', `inspect done status=${report.status} candidates=${report.api?.candidateCount || 0}`);
  closeHistoryDb();
  process.exit(report.status === 'failed' ? 1 : 0);
}

main().catch((err) => {
  historyLog('[HISTORY_ERROR]', 'history:inspect failed', String(err.message || err));
  closeHistoryDb();
  process.exit(2);
});
