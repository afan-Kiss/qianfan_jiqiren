const fs = require('fs');
const path = require('path');
const { resolveLogsDir, ensureDir } = require('./app-root');

function appendHistoryLog(line) {
  try {
    const dir = ensureDir(resolveLogsDir());
    const d = new Date();
    const file = path.join(
      dir,
      `history-sync-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`
    );
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch {
    // ignore
  }
}

function historyLog(tag, message, detail) {
  const base = `${new Date().toISOString()} ${tag} ${message}`;
  const line =
    detail !== undefined && detail !== null
      ? `${base} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
      : base;
  console.log(line);
  appendHistoryLog(line);
}

module.exports = {
  historyLog,
};
