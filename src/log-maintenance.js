/**
 * 调试日志清理：启动时压缩/删除过大的 jsonl，避免占满磁盘
 */
const fs = require('fs');
const path = require('path');
const config = require('./wechat/wxbot-new-config');
const { println } = require('./utils');

const DEFAULT_MAX_MB = 2;
const DEFAULT_KEEP_DAYS = 5;

function trimJsonlFile(filePath, maxBytes) {
  if (!fs.existsSync(filePath)) return { trimmed: false };
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) return { trimmed: false, size: stat.size };

  const fd = fs.openSync(filePath, 'r');
  const start = Math.max(0, stat.size - maxBytes);
  const len = stat.size - start;
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, start);
  fs.closeSync(fd);

  const text = buf.toString('utf8');
  const firstLine = text.indexOf('\n');
  const kept = firstLine >= 0 ? text.slice(firstLine + 1) : text;
  fs.writeFileSync(filePath, kept, 'utf8');
  return { trimmed: true, before: stat.size, after: kept.length };
}

function cleanupDebugLogs(options = {}) {
  const root = options.root || config.root || path.resolve(__dirname, '..');
  const dir = path.join(root, 'logs', 'debug');
  if (!fs.existsSync(dir)) return { removed: 0, trimmed: 0 };

  const maxBytes = (options.maxFileMB || DEFAULT_MAX_MB) * 1024 * 1024;
  const keepMs = (options.keepDays || DEFAULT_KEEP_DAYS) * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let removed = 0;
  let trimmed = 0;

  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const filePath = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }

    if (now - stat.mtimeMs > keepMs) {
      try {
        fs.unlinkSync(filePath);
        removed += 1;
      } catch {
        // ignore
      }
      continue;
    }

    if (stat.size > maxBytes) {
      const result = trimJsonlFile(filePath, maxBytes);
      if (result.trimmed) trimmed += 1;
    }
  }

  return { removed, trimmed, dir };
}

function runStartupLogMaintenance() {
  const result = cleanupDebugLogs();
  if (result.removed || result.trimmed) {
    println(
      `[日志] 已清理调试文件：删除 ${result.removed} 个过期文件，截断 ${result.trimmed} 个大文件`
    );
  }
}

module.exports = {
  cleanupDebugLogs,
  runStartupLogMaintenance,
  trimJsonlFile,
};
