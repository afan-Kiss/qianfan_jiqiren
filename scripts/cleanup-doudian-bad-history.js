#!/usr/bin/env node
/**
 * 清理误入库的 DOM 历史脏数据
 * npm run doudian:cleanup-bad-history
 */
const path = require('path');
const fs = require('fs');
const { cleanupBadHistoryRows, closeDb } = require('../src/platforms/doudian/doudian-data-store');

function resolveSinceMs() {
  const reportPath = path.join(process.cwd(), 'logs', 'doudian-chat-history-latest.json');
  if (!fs.existsSync(reportPath)) return 0;
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (report.startedAt) {
      return new Date(report.startedAt).getTime() - 5 * 60 * 1000;
    }
  } catch {
    // ignore
  }
  return 0;
}

async function main() {
  const dbPath = path.join(process.cwd(), 'logs', 'doudian-chat-history.db');
  if (!fs.existsSync(dbPath)) {
    console.log(
      JSON.stringify(
        {
          success: true,
          badRowsFound: 0,
          badRowsDeleted: 0,
          badRowsMigratedToCandidates: 0,
          message: 'database_not_found',
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  process.env.DOUDIAN_VERIFY_DB = dbPath;
  closeDb();

  const sinceMs = resolveSinceMs();
  const result = cleanupBadHistoryRows({
    sinceMs,
    shopId: '213196845',
    rejectReason: 'bad_history_false_positive_wrong_shop_unknown_direction',
  });

  console.log(
    JSON.stringify(
      {
        success: true,
        dbPath,
        sinceMs: sinceMs || null,
        ...result,
      },
      null,
      2
    )
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('cleanup 异常:', err.message || err);
  process.exit(1);
});
