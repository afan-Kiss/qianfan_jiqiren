const fs = require('fs');
const path = require('path');
const { resolveLogsDir, ensureDir } = require('./app-root');

const LOG_PREFIX = '[抖店桥]';

function formatTime() {
  return new Date().toISOString();
}

function println(...args) {
  const line = `${formatTime()} ${LOG_PREFIX} ${args.join(' ')}`;
  console.log(line);
  appendLogFile(line);
}

function appendLogFile(line) {
  try {
    const dir = ensureDir(resolveLogsDir());
    const d = new Date();
    const file = path.join(
      dir,
      `doudian-bridge-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`
    );
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch {
    // ignore log file errors
  }
}

module.exports = {
  LOG_PREFIX,
  println,
  formatTime,
};
