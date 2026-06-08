const fs = require('fs');
const { spawn, execSync } = require('child_process');
const net = require('net');
const config = require('../wechat/wxbot-new-config');
const { checkWxbotHealth } = require('../wxbot-new-health');
const { syncWxbotCallbackConfig } = require('../wxbot-new-api');
const { startWxbotCallbackServer } = require('../wxbot-new-callback-server');
const { ok, fail } = require('./adapter-result');

function isSimMode() {
  return process.env.QIANFAN_SIM_MODE === '1';
}

let activeServer = null;
let activePort = null;
let wxbotStartedByRuntime = false;

function isDistributedRuntime() {
  return process.env.QIANFAN_RUNTIME_MODE === 'distributed';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPortInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(true));
    tester.once('listening', () => tester.close(() => resolve(false)));
    tester.listen(port, host);
  });
}

function ensureWxbotExe() {
  if (!fs.existsSync(config.wxbotExe)) {
    throw new Error(`未找到 wxbot.exe：${config.wxbotExe}`);
  }
}

function killExistingWechat() {
  if (!config.oneClick.autoKillExistingWechat) return;
  for (const proc of ['Weixin.exe', 'WeChat.exe', 'wxbot.exe']) {
    try {
      execSync(`taskkill /F /IM ${proc}`, { stdio: 'ignore' });
    } catch {
      // ignore
    }
  }
}

function startWxbotExe() {
  spawn(config.wxbotExe, [], {
    cwd: config.wxbotRuntimeDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  }).unref();
  wxbotStartedByRuntime = true;
}

function stopWxbotRuntime() {
  wxbotStartedByRuntime = false;
  try {
    execSync('taskkill /F /IM wxbot.exe', { stdio: 'ignore' });
    return { ok: true, stopped: true };
  } catch {
    return { ok: true, stopped: false };
  }
}

async function waitForInjection(maxWaitMs = 120000) {
  const interval = config.oneClick.healthCheckIntervalMs || 2000;
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    const report = await checkWxbotHealth();
    if (report.ok || report.wrongLoginWxid) return report;
    await sleep(interval);
  }
  return checkWxbotHealth();
}

async function prepareWechatRuntime() {
  if (isSimMode()) {
    return ok({ report: { ok: true, sim: true } });
  }
  try {
    ensureWxbotExe();
    if (isDistributedRuntime()) {
      const existing = await checkWxbotHealth();
      if (existing.apiOk && existing.injectOk) {
        return ok({ report: existing, reused: true });
      }
      if (existing.apiOk) {
        const report = await waitForInjection();
        if (report.wrongLoginWxid) {
          return fail(new Error(report.reason || '微信登录账号不匹配'), 'WECHAT_WRONG_LOGIN');
        }
        if (report.ok) {
          return ok({ report, reused: true });
        }
      }
    }
    killExistingWechat();
    startWxbotExe();
    const report = await waitForInjection();
    if (report.wrongLoginWxid) {
      return fail(new Error('当前登录微信不是机器人号'), 'WRONG_LOGIN_WXID');
    }
    if (!report.ok) {
      return fail(new Error(report.reason || report.brief || '微信未就绪'), 'WECHAT_NOT_READY');
    }
    await syncWxbotCallbackConfig();
    return ok({ report });
  } catch (err) {
    return fail(err, 'WECHAT_BOOT_FAILED');
  }
}

async function stopCallbackServer() {
  if (!activeServer) return ok({ stopped: true, alreadyStopped: true });
  const server = activeServer;
  activeServer = null;
  activePort = null;
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
  await sleep(300);
  return ok({ stopped: true });
}

async function startCallbackServer(onCallback) {
  if (isSimMode()) {
    return ok({ server: null, port: null, sim: true, onCallback });
  }
  try {
    if (activeServer) {
      return fail(new Error('callback server 已在当前 worker 内运行'), 'CALLBACK_ALREADY_STARTED');
    }

    const port = config.callbackPort || 8787;
    const busy = await isPortInUse(port);

    if (busy && isDistributedRuntime()) {
      return fail(
        new Error(`8787 回调端口已被占用，distributed runtime 不允许重复启动 callback server`),
        'CALLBACK_PORT_BUSY',
      );
    }

    const state = await startWxbotCallbackServer({
      onCallback,
      silent: true,
      forcePort: !isDistributedRuntime(),
    });

    if (state.alreadyRunning) {
      return fail(new Error('8787 回调端口仍被占用'), 'CALLBACK_PORT_BUSY');
    }

    activeServer = state.server;
    activePort = state.port;
    return ok({ server: state.server, port: state.port });
  } catch (err) {
    return fail(err, 'CALLBACK_START_FAILED');
  }
}

function getCallbackServerState() {
  return {
    running: Boolean(activeServer),
    port: activePort,
    distributed: isDistributedRuntime(),
  };
}

module.exports = {
  prepareWechatRuntime,
  startCallbackServer,
  stopCallbackServer,
  stopWxbotRuntime,
  getCallbackServerState,
};
