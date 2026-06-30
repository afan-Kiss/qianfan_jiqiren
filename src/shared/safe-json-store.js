const fs = require('fs');
const path = require('path');

const CRITICAL_BASENAMES = new Set([
  'qianfan-send-pending.json',
  'pending-notifications.json',
  'qianfan-sent-replies.json',
  'sent-notification-map.json',
  'wechat-reply-dedup.json',
  'notified-message-ids.json',
  'buyer-notify-claims.json',
  'wechat-runtime-state.json',
]);

function isCriticalFile(file) {
  return CRITICAL_BASENAMES.has(path.basename(String(file || '')));
}

function backupCorruptFile(file, err) {
  const corruptPath = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, corruptPath);
  } catch {
    try {
      fs.copyFileSync(file, corruptPath);
      fs.unlinkSync(file);
    } catch {
      // ignore backup failure
    }
  }
  const msg = `[safe-json] 关键状态文件 JSON 损坏: ${file} → 已备份 ${corruptPath}: ${err?.message || err}`;
  console.error(msg);
  return corruptPath;
}

function readFromBak(file) {
  const bak = `${file}.bak`;
  if (!fs.existsSync(bak)) return null;
  return JSON.parse(fs.readFileSync(bak, 'utf8'));
}

function readJson(file, fallback, options = {}) {
  const critical = options.critical ?? isCriticalFile(file);

  if (!fs.existsSync(file)) {
    if (critical) {
      try {
        const fromBak = readFromBak(file);
        if (fromBak !== null) {
          console.warn(`[safe-json] 主文件缺失，从 .bak 读取: ${file}`);
          return fromBak;
        }
      } catch (err) {
        const error = new Error(`关键 JSON 主文件缺失且 .bak 损坏: ${file} (${err.message})`);
        error.code = 'JSON_CORRUPT_CRITICAL';
        throw error;
      }
    }
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (!critical) {
      console.warn(`[safe-json] JSON 解析失败 ${file}: ${err.message}`);
      return fallback;
    }
    backupCorruptFile(file, err);
    try {
      const fromBak = readFromBak(file);
      if (fromBak !== null) {
        console.error(`[safe-json] 主文件损坏，从 .bak 读取: ${file}`);
        return fromBak;
      }
    } catch (bakErr) {
      const error = new Error(`关键 JSON 损坏且 .bak 不可用: ${file} (${bakErr.message})`);
      error.code = 'JSON_CORRUPT_CRITICAL';
      throw error;
    }
    const error = new Error(`关键 JSON 损坏已备份，无可用 .bak: ${file}`);
    error.code = 'JSON_CORRUPT_CRITICAL';
    throw error;
  }
}

function fsyncFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Windows 某些环境对 fsync 可能 EPERM，忽略后仍依赖 rename 原子性
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

function writeJson(file, data) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const bak = `${file}.bak`;
  let lastErr = null;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${attempt}.tmp`);
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fsyncFile(tmp);

      if (fs.existsSync(bak)) {
        try {
          fs.unlinkSync(bak);
        } catch {
          // ignore stale bak cleanup
        }
      }
      if (fs.existsSync(file)) {
        try {
          fs.renameSync(file, bak);
        } catch {
          fs.copyFileSync(file, bak);
        }
      }

      try {
        fs.renameSync(tmp, file);
      } catch {
        fs.copyFileSync(tmp, file);
        try {
          fs.unlinkSync(tmp);
        } catch {
          // ignore tmp cleanup
        }
      }
      return;
    } catch (err) {
      lastErr = err;
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        // ignore tmp cleanup errors
      }
    }
  }
  throw lastErr || new Error(`writeJson failed: ${file}`);
}

module.exports = {
  readJson,
  writeJson,
  isCriticalFile,
  backupCorruptFile,
};
