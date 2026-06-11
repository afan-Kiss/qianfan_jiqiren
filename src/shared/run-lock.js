const fs = require('fs');
const path = require('path');

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function ensureLockDir(lockPath) {
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readLockFile(lockPath) {
  try {
    if (!fs.existsSync(lockPath)) return null;
    const raw = fs.readFileSync(lockPath, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function writeLockFile(lockPath, data) {
  ensureLockDir(lockPath);
  fs.writeFileSync(lockPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function removeLockFile(lockPath) {
  try {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function inspectLock(lockPath) {
  const lock = readLockFile(lockPath);
  if (!lock) {
    return { exists: false, alive: false, stale: false, lock: null };
  }
  const alive = isPidAlive(lock.pid);
  return { exists: true, alive, stale: !alive, lock };
}

function releaseLockIfOwned(lockPath, pid = process.pid) {
  const current = readLockFile(lockPath);
  if (!current) return false;
  if (Number(current.pid) !== Number(pid)) return false;
  return removeLockFile(lockPath);
}

function registerLockCleanup(lockPath, pid = process.pid) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    releaseLockIfOwned(lockPath, pid);
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  process.on('uncaughtException', (err) => {
    cleanup();
    console.error(err?.message || err);
    process.exit(1);
  });
  return cleanup;
}

module.exports = {
  isPidAlive,
  readLockFile,
  writeLockFile,
  removeLockFile,
  inspectLock,
  releaseLockIfOwned,
  registerLockCleanup,
  ensureLockDir,
};
