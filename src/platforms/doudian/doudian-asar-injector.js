const { getDoudianConfig } = require('../../shared/config');
const { println } = require('../../shared/logger');
const { analyzeDoudianInstall } = require('./doudian-asar-analyzer');
const { applyAsarPatch, getPatchStatus, rollbackAsarPatch } = require('./doudian-asar-patcher');
const { BRIDGE_EVENTS } = require('./doudian-types');

async function analyzeInstallRoute(installDir, options = {}) {
  println('未发现 DevTools 监听端口，切换 asar 分析路线');
  const report = analyzeDoudianInstall(installDir, { cdpHint: options.cdpHint || null });
  const patchStatus = getPatchStatus(installDir);

  return {
    route: 'asar',
    ok: report.ok,
    report,
    patchStatus,
    recommendations: report.recommendations,
  };
}

async function tryAsarInject(installDir, options = {}) {
  const cfg = getDoudianConfig();
  const wsServer = options.wsServer;
  const installPath = installDir || cfg.installDir;

  if (!installPath) {
    println('asar 路线失败：未配置 doudian.installDir');
    return { ok: false, reason: 'install_dir_missing' };
  }

  const analysis = await analyzeInstallRoute(installPath, options);
  if (!analysis.ok) {
    return { ok: false, reason: analysis.report?.reason || 'analyze_failed', analysis };
  }

  const patchStatus = analysis.patchStatus;
  if (!patchStatus.patched) {
    if (cfg.enableAsarPatch || options.forcePatch) {
      const patchResult = await applyAsarPatch(installPath, {
        bridgePort: cfg.bridgePort,
        force: options.forcePatch,
      });
      if (!patchResult.ok) {
        return { ok: false, reason: patchResult.reason, analysis, patchResult };
      }
      return {
        ok: true,
        route: 'asar',
        phase: 'patched_need_restart',
        message: 'asar 已 patch，请重启抖店客户端后 bridge 将自动连接',
        patchResult,
        analysis,
      };
    }

    println('patch 默认未启用，仅输出建议');
    return {
      ok: false,
      reason: 'patch_not_enabled',
      route: 'asar',
      phase: 'analysis_only',
      message: '已完成 asar 分析。启用 doudian.enableAsarPatch=true 并重启客户端后可注入',
      analysis,
      recommendations: analysis.recommendations,
    };
  }

  println('asar 已 patch，等待页面加载后 bridge 连接本地 WS');
  if (wsServer) {
    const waitResult = await waitAsarBridgeReady(wsServer, options.readyTimeoutMs || 120000);
    if (waitResult.ok) {
      println(`bridge 已连接 bridgeId=${waitResult.bridgeId || ''}`);
      return {
        ok: true,
        route: 'asar',
        phase: 'bridge_connected',
        bridgeId: waitResult.bridgeId,
        analysis,
      };
    }
    return {
      ok: false,
      reason: 'bridge_wait_timeout',
      route: 'asar',
      phase: 'waiting_bridge',
      message: 'asar 已 patch 但尚未收到 bridge.ready，请确认抖店客服页已打开',
      analysis,
      waitResult,
    };
  }

  return {
    ok: true,
    route: 'asar',
    phase: 'patched_waiting',
    analysis,
  };
}

function waitAsarBridgeReady(wsServer, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const bridge = wsServer.getPrimaryBridge();
      if (bridge?.ready) {
        clearInterval(timer);
        off && off();
        resolve({ ok: true, bridgeId: bridge.bridgeId });
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        off && off();
        resolve({ ok: false, reason: 'timeout' });
      }
    }, 2000);

    function onReady(envelope) {
      if (envelope.type === BRIDGE_EVENTS.READY) {
        clearInterval(timer);
        off && off();
        resolve({ ok: true, bridgeId: envelope.bridgeId });
      }
    }

    const off = wsServer.on(BRIDGE_EVENTS.READY, onReady);
    const existing = wsServer.getPrimaryBridge();
    if (existing?.ready) {
      clearInterval(timer);
      off && off();
      resolve({ ok: true, bridgeId: existing.bridgeId });
    }
  });
}

module.exports = {
  analyzeInstallRoute,
  tryAsarInject,
  waitAsarBridgeReady,
  rollbackAsarPatch,
  getPatchStatus,
};
