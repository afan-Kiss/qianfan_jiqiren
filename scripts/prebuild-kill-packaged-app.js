const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const WIN_UNPACKED = path.join(DIST, 'win-unpacked');
const DEFAULT_TIMEOUT_MS = 12000;

const IMAGE_NAMES = [
  '千帆客服台机器人.exe',
  'wxbot.exe',
];

function run(command, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    execSync(command, { stdio: 'ignore', timeout: timeoutMs, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killByImageNames() {
  for (const image of IMAGE_NAMES) {
    console.log(`[prebuild] taskkill ${image}...`);
    run(`taskkill /F /T /IM "${image}"`, 8000);
  }
}

function killProcessesUnderDist() {
  if (process.platform !== 'win32') return;
  console.log('[prebuild] stopping processes under dist/win-unpacked...');
  const rootEscaped = ROOT.replace(/\\/g, '\\\\');
  const script = [
    'Get-Process -ErrorAction SilentlyContinue',
    `| Where-Object { $_.Path -and ($_.Path -like '*win-unpacked*' -or $_.Path -like '*${rootEscaped}\\\\dist\\\\*') }`,
    '| ForEach-Object {',
    '  try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {}',
    '}',
  ].join(' ');
  run(`powershell -NoProfile -Command "${script}"`, 15000);
}

function stampBackupPath(target) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${target}.locked-${stamp}`;
}

function tryRenameLockedDir(target) {
  const backup = stampBackupPath(target);
  try {
    fs.renameSync(target, backup);
    console.log(`[prebuild] renamed locked ${path.basename(target)} -> ${path.basename(backup)}`);
    return true;
  } catch (err) {
    console.warn(`[prebuild] rename failed: ${err.message || err}`);
    return false;
  }
}

function tryRemoveDirQuick(target) {
  if (!fs.existsSync(target)) return true;
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
    return !fs.existsSync(target);
  } catch (err) {
    console.warn(`[prebuild] quick remove failed: ${err.message || err}`);
    return false;
  }
}

async function clearWinUnpacked() {
  if (!fs.existsSync(WIN_UNPACKED)) {
    console.log('[prebuild] dist/win-unpacked not present, ready to build');
    return;
  }

  console.log('[prebuild] clearing dist/win-unpacked...');
  // 优先 rename：避免 rmSync 在 NoveHelper.dll 等文件被占用时长时间阻塞
  if (tryRenameLockedDir(WIN_UNPACKED)) {
    return;
  }

  if (tryRemoveDirQuick(WIN_UNPACKED)) {
    console.log('[prebuild] removed dist/win-unpacked');
    return;
  }

  console.error('[prebuild] failed to clear dist/win-unpacked (files may be locked, e.g. NoveHelper.dll)');
  console.error('[prebuild] please fully exit「千帆客服台机器人」and wxbot.exe, then retry build:dir');
  process.exit(1);
}

async function main() {
  console.log('[prebuild] stopping packaged app processes...');
  killByImageNames();
  killProcessesUnderDist();
  await sleep(800);
  await clearWinUnpacked();
}

main().catch((err) => {
  console.error('[prebuild] unexpected error:', err.message || err);
  process.exit(1);
});
