const fs = require('fs');
const net = require('net');
const config = require('../wechat/wxbot-new-config');
const { syncWxbotCallbackConfig } = require('../wxbot-new-api');
const { startWxbotCallbackServer } = require('../wxbot-new-callback-server');
const {
  recoverWechatRuntime,
  evaluateWxbotHealth,
  isHealthyReport,
  isWrongLoginBlocked,
  waitForHealthyInjection,
  killWechatProcesses,
  startWxbotProcess,
  blockWrongLoginRecovery,
} = require('../wechat/wechat-runtime-recovery');
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

function stopWxbotRuntime() {
  wxbotStartedByRuntime = false;
  killWechatProcesses();
  return { ok: true, stopped: true };
}

async function prepareWechatRuntime(options = {}) {
  if (isSimMode()) {
    return ok({ report: { ok: true, sim: true } });
  }

  try {
    if (isWrongLoginBlocked()) {
      return fail(
        new Error('微信登录 wxid 不匹配，已停止自动恢复，请人工确认登录账号'),
        'WECHAT_WRONG_LOGIN_BLOCKED',
      );
    }

    const evaluation = await evaluateWxbotHealth();
    if (evaluation.wrongLogin) {
      blockWrongLoginRecovery(evaluation.report, options.reason || 'boot');
      return fail(
        new Error(evaluation.report?.reason || '当前登录微信不是机器人号'),
        'WECHAT_WRONG_LOGIN',
      );
    }

    if (options.reuseOnly) {
      if (evaluation.healthy) {
        await syncWxbotCallbackConfig();
        return ok({ report: evaluation.report, reused: true, reuseOnly: true });
      }
    } else if (evaluation.healthy) {
      await syncWxbotCallbackConfig();
      return ok({ report: evaluation.report, reused: true });
    }

    if (options.forceRecover) {
      const recovered = await recoverWechatRuntime(options.reason || 'manual_start', {
        maxWaitMs: options.maxWaitMs,
        force: true,
        onPhase: options.onPhase,
      });

      if (recovered.blocked) {
        return fail(new Error(recovered.reason || '微信登录账号不匹配'), recovered.code || 'WECHAT_WRONG_LOGIN');
      }
      if (!recovered.ok) {
        return fail(
          new Error(recovered.reason || '微信未就绪'),
          recovered.code || 'WECHAT_NOT_READY',
        );
      }

      wxbotStartedByRuntime = true;
      return ok({ report: recovered.report, recovered: true });
    }

    if (isDistributedRuntime() && evaluation.report?.apiOk && !options.forceRecover) {
      const waited = await waitForHealthyInjection(options.maxWaitMs);
      if (waited.wrongLoginWxid) {
        return fail(new Error(waited.reason || '微信登录账号不匹配'), 'WECHAT_WRONG_LOGIN');
      }
      if (isHealthyReport(waited)) {
        await syncWxbotCallbackConfig();
        return ok({ report: waited, reused: true });
      }
    }

    const recovered = await recoverWechatRuntime(options.reason || 'boot', {
      maxWaitMs: options.maxWaitMs,
      force: options.forceRecover,
      onPhase: options.onPhase,
    });

    if (recovered.blocked) {
      return fail(new Error(recovered.reason || '微信登录账号不匹配'), recovered.code || 'WECHAT_WRONG_LOGIN');
    }
    if (!recovered.ok) {
      return fail(
        new Error(recovered.reason || '微信未就绪'),
        recovered.code || 'WECHAT_NOT_READY',
      );
    }

    wxbotStartedByRuntime = true;
    return ok({ report: recovered.report, recovered: true });
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
        new Error('8787 回调端口已被占用，distributed runtime 不允许重复启动 callback server'),
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
  recoverWechatRuntime,
  startCallbackServer,
  stopCallbackServer,
  stopWxbotRuntime,
  getCallbackServerState,
  evaluateWxbotHealth,
};
