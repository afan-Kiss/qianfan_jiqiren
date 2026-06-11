const { HistorySyncManager } = require('../src/services/history/history-sync-manager');
const { closeHistoryDb } = require('../src/services/history/history-db');
const { historyLog } = require('../src/shared/history-log');

async function main() {
  historyLog('[HISTORY_SYNC]', 'history:sync start');
  const manager = new HistorySyncManager();
  const report = await manager.runSync();
  historyLog(
    '[HISTORY_SYNC]',
    `sync done status=${report.status} inserted=${report.results?.insertedMessages || 0}`
  );
  closeHistoryDb();
  process.exit(report.status === 'success' || report.status === 'partial' ? 0 : 1);
}

main().catch((err) => {
  historyLog('[HISTORY_ERROR]', 'history:sync failed', String(err.message || err));
  closeHistoryDb();
  process.exit(2);
});
