const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const WIN_UNPACKED = path.join(DIST, 'win-unpacked');

const IMAGE_NAMES = [
  '千帆客服台机器人.exe',
  'wxbot.exe',
  'electron.exe',
];

function run(command) {
  try {
    execSync(command, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy wait for short prebuild delay
  }
}

function killByImageNames() {
  for (const image of IMAGE_NAMES) {
    run(`taskkill /F /T /IM "${image}"`);
  }
}

function killProcessesUnderDist() {
  if (process.platform !== 'win32') return;
  try {
    const output = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like \'*\\\\dist\\\\*\' -or $_.ExecutablePath -like \'*win-unpacked*\') } | Select-Object -ExpandProperty ProcessId"',
      { encoding: 'utf8' },
    );
    for (const line of String(output).split(/\r?\n/)) {
      const pid = Number(String(line).trim());
      if (pid > 0) run(`taskkill /F /T /PID ${pid}`);
    }
  } catch {
    // ignore
  }
}

function removeDir(target) {
  if (!fs.existsSync(target)) return true;
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    return !fs.existsSync(target);
  } catch {
    return false;
  }
}

function main() {
  console.log('[prebuild] stopping packaged app processes...');
  killByImageNames();
  killProcessesUnderDist();
  sleep(1500);

  if (!fs.existsSync(WIN_UNPACKED)) {
    console.log('[prebuild] dist/win-unpacked not present, ready to build');
    return;
  }

  if (removeDir(WIN_UNPACKED)) {
    console.log('[prebuild] removed dist/win-unpacked');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${WIN_UNPACKED}.locked-${stamp}`;
  try {
    fs.renameSync(WIN_UNPACKED, backup);
    console.log(`[prebuild] renamed locked dist/win-unpacked -> ${path.basename(backup)}`);
    return;
  } catch (err) {
    console.error('[prebuild] failed to clear dist/win-unpacked:', err.message || err);
    console.error('[prebuild] please fully exit「千帆客服台机器人」and wxbot.exe, then retry build:dir');
    process.exit(1);
  }
}

main();
