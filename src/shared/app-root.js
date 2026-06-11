const path = require('path');
const fs = require('fs');

let projectRootCache = null;

function resolveProjectRoot() {
  if (projectRootCache) return projectRootCache;
  if (process.env.DOUDIAN_APP_ROOT) {
    projectRootCache = path.resolve(process.env.DOUDIAN_APP_ROOT);
    return projectRootCache;
  }
  projectRootCache = path.resolve(__dirname, '..', '..');
  return projectRootCache;
}

function resolveDataDir() {
  if (process.env.DOUDIAN_DATA_DIR) {
    return path.resolve(process.env.DOUDIAN_DATA_DIR);
  }
  return path.join(resolveProjectRoot(), 'data');
}

function resolveLogsDir() {
  return path.join(resolveProjectRoot(), 'logs');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  resolveProjectRoot,
  resolveDataDir,
  resolveLogsDir,
  ensureDir,
};
