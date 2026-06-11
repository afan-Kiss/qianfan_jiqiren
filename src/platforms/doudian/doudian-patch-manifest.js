const fs = require('fs');
const path = require('path');
const { PATCH_MARKER, PRELOAD_TEST_FLAG } = require('./doudian-asar-patch-constants');
const { resolveInstallPaths } = require('./doudian-asar-analyzer');
const { BACKUP_ASAR_NAME } = require('./doudian-asar-patch-verify');

function formatBackupTimestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function getProjectLogsDir(cwd = process.cwd()) {
  return path.join(cwd, 'logs');
}

function getTimestampedBackupPath(cwd = process.cwd(), date = new Date()) {
  return path.join(getProjectLogsDir(cwd), 'backups', `app.asar.${formatBackupTimestamp(date)}.bak`);
}

function getManifestLatestPath(cwd = process.cwd()) {
  return path.join(getProjectLogsDir(cwd), 'doudian-patch-manifest-latest.json');
}

function readDoudianVersion(installDir) {
  const paths = resolveInstallPaths(installDir);
  const candidates = [
    path.join(paths.root, 'version.json'),
    path.join(paths.root, 'tt_electron_config.json'),
    path.join(paths.root, 'package.json'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const version = json.version || json.appVersion || json.clientVersion || json.productVersion;
      if (version) return String(version);
    } catch {
      // ignore
    }
  }
  const base = path.basename(String(installDir || '').replace(/\\/g, '/'));
  return base || 'unknown';
}

function buildRollbackCommand(installDir) {
  const normalized = String(installDir || '').replace(/\//g, '\\');
  return `node scripts/rollback-doudian-asar.js "${normalized}"`;
}

function writePatchManifest(options = {}) {
  const {
    installDir,
    patchResult = {},
    verifyResult = {},
    backupPath = '',
    cwd = process.cwd(),
  } = options;

  const paths = resolveInstallPaths(installDir);
  const verify = verifyResult.ok !== undefined ? verifyResult : patchResult.verify || {};
  const patchedFiles = (verify.patchedFiles || []).map((f) => f.innerPath || f.displayPath || String(f));
  const manifest = {
    installDir: paths.root,
    appAsar: paths.asarPath,
    doudianVersion: readDoudianVersion(installDir),
    patchTime: new Date().toISOString(),
    patchedFiles,
    patchMarkers: [PATCH_MARKER, PRELOAD_TEST_FLAG].filter(Boolean),
    backupPath: backupPath || patchResult.meta?.backupAsar || path.join(paths.resourcesDir, BACKUP_ASAR_NAME),
    timestampedBackupPath: backupPath || '',
    verifyResult: Boolean(verify.ok),
    rollbackCommand: buildRollbackCommand(paths.root),
    bridgePort: patchResult.meta?.bridgePort || verify.bridgePort || null,
    wsUrl: patchResult.meta?.wsUrl || verify.expectedWsUrl || '',
  };

  const latestPath = getManifestLatestPath(cwd);
  fs.mkdirSync(path.dirname(latestPath), { recursive: true });
  fs.writeFileSync(latestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, manifestPath: latestPath };
}

function readLatestPatchManifest(cwd = process.cwd()) {
  const manifestPath = getManifestLatestPath(cwd);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function createTimestampedAsarBackup(asarPath, cwd = process.cwd()) {
  if (!fs.existsSync(asarPath)) {
    return { ok: false, reason: 'asar_missing', path: asarPath };
  }
  const backupPath = getTimestampedBackupPath(cwd);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(asarPath, backupPath);
  return { ok: true, backupPath };
}

module.exports = {
  formatBackupTimestamp,
  getTimestampedBackupPath,
  getManifestLatestPath,
  writePatchManifest,
  readLatestPatchManifest,
  createTimestampedAsarBackup,
  buildRollbackCommand,
  readDoudianVersion,
};
