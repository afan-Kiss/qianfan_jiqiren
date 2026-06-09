const { execSync } = require('child_process');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessByImage(processName) {
  const name = String(processName || '').trim();
  if (!name) return false;
  try {
    execSync(`taskkill /F /IM "${name}"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 软件退出时结束由中转拉起的附属进程（不结束 WeChat.exe / Weixin.exe / 千帆客服工作台）。
 * 千帆仅在「运行中且未开调试端口、需切换调试模式启动」时由 launcher 结束，退出软件时不结束千帆。
 * @param {{ killWxbot?: boolean, killQianfan?: boolean, reason?: string }} options
 */
async function stopRuntimeChildProcesses(options = {}) {
  const killWxbot = options.killWxbot !== false;
  // 无论 options.killQianfan 传什么，退出时都不结束千帆
  void options.killQianfan;

  if (killWxbot) {
    killProcessByImage('wxbot.exe');
  }

  await sleep(300);
  return { killWxbot, killQianfan: false, reason: options.reason || 'app-quit' };
}

module.exports = {
  killProcessByImage,
  stopRuntimeChildProcesses,
};
