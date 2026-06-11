#!/usr/bin/env node
/**
 * 启动本地 WS 桥 + 测试版抖店，等待 bridge 事件
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { getDoudianWsServer } = require('../src/platforms/doudian/doudian-ws-server');
const { BRIDGE_EVENTS } = require('../src/platforms/doudian/doudian-types');
const { getDoudianConfig } = require('../src/shared/config');
const { WORKSPACE_URL_PATTERN } = require('../src/platforms/doudian/doudian-asar-patch-constants');
const {
  TEST_INSTALL_DIR,
  redactText,
  sleep,
  isDoudianRunning,
} = require('./lib/auto-verify-utils');
const { BridgeTracker, IM_WATCH_TYPES, summarizeEvent } = require('./lib/bridge-tracker');
const {
  ensureDoudianImWorkspaceOpen,
  attachOpenImAttemptResponse,
  DEFAULT_IM_WAIT_MS,
} = require('../src/platforms/doudian/doudian-im-workspace-ensurer');

const WATCH_TYPES = new Set([
  BRIDGE_EVENTS.HELLO,
  BRIDGE_EVENTS.READY,
  BRIDGE_EVENTS.HEARTBEAT,
  'bridge.dom_ready',
  'bridge.window_load',
  BRIDGE_EVENTS.ERROR,
  'bridge.log',
  'bridge.pong',
  'bridge.open_im_attempt',
]);

const IM_SUCCESS_TYPES = new Set([
  BRIDGE_EVENTS.HELLO,
  BRIDGE_EVENTS.READY,
  BRIDGE_EVENTS.HEARTBEAT,
  'bridge.dom_ready',
  'bridge.window_load',
]);

function stdoutMentionsIm(text) {
  const t = String(text || '');
  return /im\.jinritemai\.com/i.test(t) || /window open im/i.test(t) || /pc_seller_desk_v2/i.test(t);
}

function classifyImFailure(result) {
  if (!result.wsStarted) return 'ws_server_error';
  if (!result.homepageBridgeSuccess) return 'homepage_bridge_failed';
  const imHintInLogs =
    result.stdoutImHints > 0 ||
    result.countImRelatedHrefs > 0 ||
    (result.bridgeEvents || []).some(
      (e) => e.href && e.href.includes('im.jinritemai.com') && !e.isImWorkspace
    );
  if (!imHintInLogs && !result.hasImHrefSeen) return 'im_page_not_opened';
  if (imHintInLogs && !result.imBridgeSuccess) return 'im_page_opened_but_no_bridge';
  return 'patch_not_applied_to_im_webview';
}

async function startBridgeAndClient(options = {}) {
  const cfg = getDoudianConfig();
  const bridgePort = Number(options.bridgePort || cfg.bridgePort || 19527);
  const installDir = options.installDir || TEST_INSTALL_DIR;
  const exePath = path.join(installDir, 'doudian.exe');
  const imMode = Boolean(options.imMode);
  const waitMs = Number(options.waitMs || (imMode ? 180000 : 90000));

  const tracker = new BridgeTracker();
  const result = {
    ok: false,
    imMode,
    bridgePort,
    installDir,
    exePath,
    wsStarted: false,
    clientStarted: false,
    clientPid: null,
    doudianRunningAfterStart: false,
    bridgeEvents: [],
    allBridges: [],
    bridgeCount: 0,
    firstBridgeHello: null,
    firstBridgeReady: null,
    heartbeatCount: 0,
    homepageBridgeSuccess: false,
    imBridgeSuccess: false,
    firstHomepageBridge: null,
    firstImBridge: null,
    imHeartbeatCount: 0,
    imOpenAttempts: [],
    imWaitMs: waitMs,
    stdoutImHints: 0,
    countImRelatedHrefs: 0,
    hasImHrefSeen: false,
    stdoutLines: [],
    stderrLines: [],
    errors: [],
    warnings: [],
    nextActions: [],
  };

  if (!fs.existsSync(exePath)) {
    result.errors.push(`测试版 doudian.exe 不存在: ${exePath}`);
    return result;
  }

  let wsServer;
  try {
    wsServer = getDoudianWsServer({ port: bridgePort });
    await wsServer.start();
    result.wsStarted = true;
  } catch (err) {
    result.errors.push(`WS 服务启动失败: ${err.message || err}`);
    result.failStep = 'ws_server_error';
    return result;
  }

  const onEvent = (envelope) => {
    if (!WATCH_TYPES.has(envelope.type)) return;
    const summary = tracker.recordEvent(envelope);
    if (!summary) return;
    result.bridgeEvents.push(summary);
    console.log(`[bridge-event] ${JSON.stringify(summary)}`);

    if (envelope.type === 'bridge.open_im_attempt') {
      attachOpenImAttemptResponse(result.imOpenAttempts, envelope);
    }

    if (envelope.type === BRIDGE_EVENTS.HELLO && !result.firstBridgeHello) {
      result.firstBridgeHello = summary;
    }
    if (envelope.type === BRIDGE_EVENTS.READY && !result.firstBridgeReady) {
      result.firstBridgeReady = summary;
    }
    if (envelope.type === BRIDGE_EVENTS.HEARTBEAT) {
      result.heartbeatCount += 1;
    }

    if (summary.isHomepage && IM_SUCCESS_TYPES.has(summary.type) && !result.firstHomepageBridge) {
      result.firstHomepageBridge = summary;
      result.homepageBridgeSuccess = true;
    }
    if (summary.isImWorkspace && IM_SUCCESS_TYPES.has(summary.type)) {
      if (!result.firstImBridge) result.firstImBridge = summary;
      result.imBridgeSuccess = true;
      result.hasImHrefSeen = true;
    }
    if (summary.href && summary.href.includes('im.jinritemai.com')) {
      result.hasImHrefSeen = true;
    }
  };

  wsServer.on('*', onEvent);

  const child = spawn(exePath, [], {
    cwd: installDir,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  result.clientStarted = true;
  result.clientPid = child.pid;

  child.stdout.on('data', (buf) => {
    const line = redactText(buf.toString('utf8').trim());
    if (!line) return;
    result.stdoutLines.push(line);
    if (result.stdoutLines.length > 200) result.stdoutLines.shift();
    if (stdoutMentionsIm(line)) result.stdoutImHints += 1;
  });
  child.stderr.on('data', (buf) => {
    const line = redactText(buf.toString('utf8').trim());
    if (!line) return;
    result.stderrLines.push(line);
    if (result.stderrLines.length > 200) result.stderrLines.shift();
    if (stdoutMentionsIm(line)) result.stdoutImHints += 1;
  });

  child.on('error', (err) => {
    result.errors.push(`doudian.exe 启动错误: ${err.message || err}`);
  });

  await sleep(3000);
  const running = isDoudianRunning();
  result.doudianRunningAfterStart = running.length > 0;
  if (!result.doudianRunningAfterStart) {
    result.warnings.push('doudian.exe 启动后未检测到 doudian 进程，可能仍在加载');
  }

  const started = Date.now();

  if (imMode) {
    const imResult = await ensureDoudianImWorkspaceOpen({
      wsServer,
      bridgeTracker: tracker,
      timeoutMs: waitMs,
      openIfMissing: true,
      onOpenAttempt: (attempt) => {
        result.imOpenAttempts.push(attempt);
        result.imOpenAttempted = true;
      },
    });

    result.imBridgeSuccess = imResult.imBridgeSeen === 1;
    result.imOpenAttempted = imResult.imOpenAttempted;
    result.imOpenSuccess = imResult.imOpenSuccess;
    result.imOpenAttempts = imResult.imOpenAttempts;
    result.homepageBridgeSuccess = imResult.homepageBridgeSuccess;
    if (imResult.firstImBridge) result.firstImBridge = imResult.firstImBridge;
    result.ok = imResult.imBridgeSeen === 1;
    result.waitMs = imResult.imWorkspaceWaitMs;
    const cls = tracker.getBridgeClassificationCounts?.() || {};
    result.homepageBridgeSeen = cls.homepageBridgeSeen || 0;
    result.emptyBridgeSeen = cls.emptyBridgeSeen || 0;
    result.rustWorkerBridgeSeen = cls.rustWorkerBridgeSeen || 0;
  } else {
    while (Date.now() - started < waitMs) {
      if (result.firstBridgeHello && result.heartbeatCount > 0) {
        result.ok = true;
        break;
      }
      await sleep(2000);
    }
    result.waitMs = Date.now() - started;
  }

  result.allBridges = tracker.getAllBridges();
  result.bridgeCount = tracker.getBridgeCount();
  result.imHeartbeatCount = tracker.getImHeartbeatCount();
  result.countImRelatedHrefs = tracker.countImRelatedHrefs();
  if (!result.firstHomepageBridge) {
    result.firstHomepageBridge = tracker.getFirstHomepageBridgeEvent();
    result.homepageBridgeSuccess = Boolean(result.firstHomepageBridge);
  }

  if (imMode) {
    if (!result.ok) {
      result.failStep = classifyImFailure(result);
      if (result.failStep === 'homepage_bridge_failed') {
        result.errors.push('未收到首页 bridge 事件');
      } else if (result.failStep === 'im_page_not_opened') {
        result.errors.push(`首页 bridge 已连通，但 ${waitMs / 1000}s 内未出现 IM 客服页 bridge`);
        result.warnings.push('未自动打开 IM 页：已尝试 debug.open_im_workspace，无 UI 自动化兜底');
      } else if (result.failStep === 'im_page_opened_but_no_bridge') {
        result.errors.push('日志中有 IM 页迹象，但未收到 IM workspace bridge 事件');
      } else if (result.failStep === 'patch_not_applied_to_im_webview') {
        result.errors.push('推测 preload 未进入 IM webview，或 IM 页使用了不同 preload');
      } else if (result.failStep === 'ws_server_error') {
        result.errors.push('本地 WS 服务异常');
      }
      result.nextActions = [
        '确认 patch 标记仍在测试目录 app.asar 内',
        `手动打开客服页 ${WORKSPACE_URL_PATTERN} 后重跑 npm run doudian:auto-verify-im`,
        '检查 IM webview 是否使用 electron/webview_preload_index.js 或 vendor.js',
        '查看 logs/doudian-auto-verify-im-latest.json 中 allBridges 与 imOpenAttempts',
      ];
    }
  } else if (!result.ok) {
    if (!result.firstBridgeHello) result.errors.push('90 秒内未收到 bridge.hello');
    if (result.heartbeatCount === 0) result.errors.push('90 秒内未收到 bridge.heartbeat');
    result.nextActions = [
      '确认已从测试目录启动 doudian.exe',
      '运行 node scripts/verify-doudian-asar-patch.js 确认 patch 标记',
    ];
  }

  try {
    child.unref();
  } catch {
    // ignore
  }

  return result;
}

async function main() {
  const imMode = process.argv.includes('--im');
  const result = await startBridgeAndClient({ imMode, waitMs: imMode ? 180000 : 90000 });
  console.log('\n=== start-bridge-and-client 结果 ===');
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { startBridgeAndClient, summarizeEvent };
