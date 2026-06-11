const { execSync } = require('child_process');
const { getDoudianConfig } = require('../../shared/config');
const { println } = require('../../shared/logger');

function listWindowsProcesses() {
  if (process.platform !== 'win32') return [];
  try {
    const output = execSync(
      'powershell -NoProfile -Command "Get-Process | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress"',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }
    );
    const parsed = JSON.parse(output || '[]');
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch (err) {
    println(`进程枚举失败：${err.message || err}`);
    return [];
  }
}

function normalizeProcessName(name) {
  return String(name || '').trim().toLowerCase();
}

function detectDoudianProcesses(options = {}) {
  const cfg = getDoudianConfig();
  const names = (options.processNames || cfg.processNames || []).map(normalizeProcessName);
  println('正在探测客户端进程');

  const processes = listWindowsProcesses();
  const matches = [];

  for (const proc of processes) {
    const procName = normalizeProcessName(proc.ProcessName);
    const title = String(proc.MainWindowTitle || '').trim();
    const exeMatch = names.some((n) => procName.includes(n.replace('.exe', '')) || n.includes(procName));
    const titleMatch = /抖店|doudian|jinritemai|抖音电商/i.test(title);
    if (exeMatch || titleMatch) {
      matches.push({
        pid: proc.Id,
        processName: proc.ProcessName,
        mainWindowTitle: title,
        matchedBy: exeMatch ? 'processName' : 'windowTitle',
      });
    }
  }

  if (matches.length) {
    println(`已发现抖店相关进程 ${matches.length} 个：${matches.map((m) => `${m.processName}(${m.pid})`).join(', ')}`);
  } else {
    println('未发现抖店客户端进程');
  }

  return {
    found: matches.length > 0,
    count: matches.length,
    processes: matches,
  };
}

module.exports = {
  listWindowsProcesses,
  detectDoudianProcesses,
};
