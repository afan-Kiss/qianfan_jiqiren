const { execSync } = require('child_process');
const { println } = require('../../shared/logger');
const {
  PROTECTED_INSTALL_DIR_PATTERN,
  TEST_INSTALL_DIR,
} = require('./doudian-asar-patch-constants');

function listWindowsProcesses() {
  if (process.platform !== 'win32') return [];
  try {
    const output = execSync(
      'powershell -NoProfile -Command "Get-Process | Select-Object Id,ProcessName | ConvertTo-Json -Compress"',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }
    );
    const parsed = JSON.parse(output || '[]');
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch (err) {
    println(`进程枚举失败：${err.message || err}`);
    return [];
  }
}

function isDoudianProcessRunning() {
  const processes = listWindowsProcesses();
  return processes.filter((p) => String(p.ProcessName || '').toLowerCase() === 'doudian');
}

function assertDoudianNotRunning() {
  const running = isDoudianProcessRunning();
  if (!running.length) {
    return { ok: true, running: [] };
  }
  const detail = running.map((p) => `doudian.exe(pid=${p.Id})`).join(', ');
  println(`patch 中止：检测到抖店进程正在运行（${detail}），请先完全关闭抖店客户端`);
  return {
    ok: false,
    reason: 'doudian_process_running',
    running,
    message: `请先关闭抖店客户端再 patch。当前运行：${detail}`,
  };
}

function assertSafeInstallPath(installDir, options = {}) {
  const normalized = String(installDir || '').replace(/\//g, '\\');
  if (!PROTECTED_INSTALL_DIR_PATTERN.test(normalized)) {
    return { ok: true };
  }
  if (options.forceOriginal) {
    println('警告：正在 patch 原安装目录（--force-original 已传入）');
    return { ok: true, forced: true };
  }
  const msg =
    `不允许直接 patch 原安装目录：${normalized}\n` +
    `建议复制到测试目录后再 patch，例如：\n` +
    `  ${TEST_INSTALL_DIR}\n` +
    `复制命令示例：\n` +
    `  npm run doudian:prepare-test\n` +
    `若确需 patch 原目录，请追加参数 --force-original`;
  println(`patch 中止：${msg.replace(/\n/g, ' | ')}`);
  return {
    ok: false,
    reason: 'protected_install_dir',
    message: msg,
    recommendedTestDir: TEST_INSTALL_DIR,
  };
}

module.exports = {
  listWindowsProcesses,
  isDoudianProcessRunning,
  assertDoudianNotRunning,
  assertSafeInstallPath,
};
