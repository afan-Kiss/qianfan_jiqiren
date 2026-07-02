const path = require('path');
const fs = require('fs');

let projectRootCache = null;
let runtimeRootCache = null;

function detectPortableDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    return path.dirname(process.env.PORTABLE_EXECUTABLE_FILE);
  }
  return '';
}

function detectPackagedExeDir() {
  if (!process.resourcesPath || !process.execPath) return '';
  const resources = process.resourcesPath.replace(/\\/g, '/');
  if (!resources.endsWith('/app.asar') && !resources.includes('/app.asar/')) return '';
  return path.dirname(process.execPath);
}

function initAppRoot(electronApp) {
  if (electronApp?.isPackaged) {
    const portableDir = detectPortableDir();
    process.env.QIANFAN_APP_ROOT = portableDir || path.dirname(electronApp.getPath('exe'));
    process.env.QIANFAN_RUNTIME_ROOT = electronApp.getAppPath();
  }
  projectRootCache = null;
  runtimeRootCache = null;
}

function resolveProjectRoot() {
  if (projectRootCache) return projectRootCache;
  if (process.env.QIANFAN_APP_ROOT) {
    projectRootCache = path.resolve(process.env.QIANFAN_APP_ROOT);
    return projectRootCache;
  }
  const portableDir = detectPortableDir();
  if (portableDir) {
    projectRootCache = path.resolve(portableDir);
    return projectRootCache;
  }
  const packagedExeDir = detectPackagedExeDir();
  if (packagedExeDir) {
    projectRootCache = path.resolve(packagedExeDir);
    return projectRootCache;
  }
  projectRootCache = path.resolve(__dirname, '..', '..');
  return projectRootCache;
}

function resolveRuntimeRoot() {
  if (runtimeRootCache) return runtimeRootCache;
  if (process.env.QIANFAN_RUNTIME_ROOT) {
    runtimeRootCache = path.resolve(process.env.QIANFAN_RUNTIME_ROOT);
    return runtimeRootCache;
  }
  runtimeRootCache = resolveProjectRoot();
  return runtimeRootCache;
}

function resolveUnpackedPath(filePath) {
  const target = String(filePath || '');
  if (!target.includes('app.asar')) return target;
  const unpacked = target.replace('app.asar', 'app.asar.unpacked');
  if (fs.existsSync(unpacked)) return unpacked;
  return target;
}

function resolveDataDir() {
  if (process.env.QIANFAN_SIM_DATA_DIR) {
    return path.resolve(process.env.QIANFAN_SIM_DATA_DIR);
  }
  return path.join(resolveProjectRoot(), 'data');
}

function resolveLogsDir() {
  return path.join(resolveProjectRoot(), 'logs');
}

function resolveWxbotRuntimeDir(projectRoot = resolveProjectRoot()) {
  const bundledDir = process.resourcesPath
    ? path.join(process.resourcesPath, 'wxbot-new-runtime')
    : '';
  if (bundledDir && fs.existsSync(path.join(bundledDir, 'wxbot.exe'))) {
    return bundledDir;
  }
  const localDir = path.join(projectRoot, 'tools', 'wxbot-new-runtime');
  if (fs.existsSync(path.join(localDir, 'wxbot.exe'))) {
    return localDir;
  }
  return localDir;
}

module.exports = {
  initAppRoot,
  resolveProjectRoot,
  resolveRuntimeRoot,
  resolveDataDir,
  resolveLogsDir,
  resolveUnpackedPath,
  resolveWxbotRuntimeDir,
};
