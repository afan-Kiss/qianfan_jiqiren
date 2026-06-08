const fs = require('fs');
const path = require('path');

function getStateFile() {
  const dir = process.env.QIANFAN_SIM_DATA_DIR;
  if (!dir) return null;
  return path.join(dir, 'sim-chaos-state.json');
}

function readState() {
  const file = getStateFile();
  if (!file || !fs.existsSync(file)) {
    return {
      qianfanSendFail: false,
      wechatNotifyFail: false,
      persistenceDelayMs: 0,
      requestTimeoutMs: 0,
    };
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(partial = {}) {
  const file = getStateFile();
  if (!file) return readState();
  const current = readState();
  const next = { ...current, ...partial, updatedAt: Date.now() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next)}\n`, 'utf8');
  return next;
}

function resetState() {
  return writeState({
    qianfanSendFail: false,
    wechatNotifyFail: false,
    persistenceDelayMs: 0,
    requestTimeoutMs: 0,
  });
}

module.exports = {
  readState,
  writeState,
  resetState,
};
