const { execSync } = require('child_process');
const config = require('../wechat/wxbot-new-config');
const { killExistingQianfanClient } = require('../qianfan-client-launcher');

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
 * 软件退出时结束由中转拉起的附属进程（不结束 WeChat.exe / Weixin.exe）。
 * @param {{ killWxbot?: boolean, killQianfan?: boolean, reason?: string }} options
 */
async function stopRuntimeChildProcesses(options = {}) {
  const qianfanCfg = config.qianfanDebug || {};
  const killWxbot = options.killWxbot !== false;
  const killQianfan = options.killQianfan !== false
    && qianfanCfg.autoCloseExistingQianfanClient !== false;

  if (killWxbot) {
    killProcessByImage('wxbot.exe');
  }
  if (killQianfan) {
    killExistingQianfanClient(
      qianfanCfg.qianfanClientProcessName || '千帆客服工作台.exe',
    );
  }

  await sleep(300);
  return { killWxbot, killQianfan, reason: options.reason || 'app-quit' };
}

module.exports = {
  killProcessByImage,
  stopRuntimeChildProcesses,
};
