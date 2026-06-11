const fs = require('fs');
const path = require('path');
const { resolveLogsDir, ensureDir } = require('./app-root');

function formatTime() {
  return new Date().toISOString();
}

function appendBridgeLog(line) {
  try {
    const dir = ensureDir(resolveLogsDir());
    const d = new Date();
    const file = path.join(
      dir,
      `cdp-bridge-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`
    );
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch {
    // ignore
  }
}

function bridgeLog(tag, message, detail) {
  const base = `${formatTime()} ${tag} ${message}`;
  const line = detail !== undefined && detail !== null ? `${base} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : base;
  console.log(line);
  appendBridgeLog(line);
}

module.exports = {
  bridgeLog,
  formatTime,
};
