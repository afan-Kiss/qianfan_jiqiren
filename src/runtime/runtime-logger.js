const fs = require('fs');
const path = require('path');

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function safeAppend(filePath, line) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, line, 'utf8');
  } catch {
    // ignore write failures
  }
}

function formatLogLine({ level = 'info', workerName = 'supervisor', traceId = '', topic = '', message = '' }) {
  const time = new Date().toISOString();
  const parts = [
    `[${time}]`,
    `[${level}]`,
    `[${workerName}]`,
    traceId ? `[trace:${traceId}]` : '',
    topic ? `[topic:${topic}]` : '',
    message,
  ].filter(Boolean);
  return `${parts.join(' ')}\n`;
}

function createRuntimeLogger(options = {}) {
  const logsDir = options.logsDir || path.join(process.cwd(), 'logs');

  function logFileFor(workerName) {
    if (!workerName || workerName === 'supervisor' || workerName === 'runtime') {
      return path.join(logsDir, `runtime-${todayKey()}.log`);
    }
    return path.join(logsDir, `worker-${workerName}-${todayKey()}.log`);
  }

  function write(entry) {
    const line = formatLogLine(entry);
    safeAppend(logFileFor(entry.workerName), line);
    if (entry.workerName !== 'supervisor' && entry.workerName !== 'runtime') {
      safeAppend(logFileFor('supervisor'), line);
    }
    return {
      time: new Date().toISOString(),
      level: entry.level || 'info',
      workerName: entry.workerName || 'supervisor',
      traceId: entry.traceId || '',
      topic: entry.topic || '',
      message: entry.message || '',
    };
  }

  return { write, formatLogLine, logFileFor };
}

module.exports = {
  createRuntimeLogger,
  formatLogLine,
};
