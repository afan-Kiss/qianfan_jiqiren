#!/usr/bin/env node
/**
 * verify-chat-history IM 打开链路专项测试
 * npm run doudian:test-history-im-open
 */
const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');
const { DoudianWsServer } = require('../src/platforms/doudian/doudian-ws-server');
const { getDoudianConfig } = require('../src/shared/config');
const { WORKSPACE_URL_PATTERN } = require('../src/platforms/doudian/doudian-asar-patch-constants');
const { BridgeTracker } = require('./lib/bridge-tracker');
const {
  ensureDoudianImWorkspaceOpen,
  attachOpenImAttemptResponse,
} = require('../src/platforms/doudian/doudian-im-workspace-ensurer');
const { shouldEnterHistoryStage } = require('./lib/doudian-chat-history-session');
const { sleep } = require('./lib/auto-verify-utils');

const IM_HREF = `https://${WORKSPACE_URL_PATTERN}`;

function historyUsesSharedImEnsurer() {
  const sessionPath = path.join(__dirname, 'lib/doudian-chat-history-session.js');
  const src = fs.readFileSync(sessionPath, 'utf8');
  return (
    src.includes("require('../../src/platforms/doudian/doudian-im-workspace-ensurer')") &&
    src.includes('runDoudianImWorkspacePhase')
  );
}

function makeHomepageHref() {
  return 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
}

function connectMockBridge(port, bridgeId, href) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/doudian/bridge`);
    const timer = setTimeout(() => reject(new Error(`connect timeout ${bridgeId}`)), 5000);
    ws.on('open', () => {
      clearTimeout(timer);
      ws.send(
        JSON.stringify({
          type: 'bridge.hello',
          bridgeId,
          timestamp: Date.now(),
          payload: { href, url: href, title: bridgeId },
        })
      );
      ws.send(
        JSON.stringify({
          type: 'bridge.ready',
          bridgeId,
          timestamp: Date.now(),
          payload: { pageUrl: href, pageTitle: bridgeId },
        })
      );
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function runSuccessPathTest(port) {
  const wsServer = new DoudianWsServer({ port });
  await wsServer.start();

  const tracker = new BridgeTracker();
  const homepageId = 'mock-history-homepage';
  const imId = 'mock-history-im';
  const imOpenAttempts = [];

  wsServer.on('*', (envelope) => {
    tracker.recordEvent(envelope);
    if (envelope.type === 'bridge.open_im_attempt') {
      attachOpenImAttemptResponse(imOpenAttempts, envelope);
    }
  });

  const homepageWs = await connectMockBridge(port, homepageId, makeHomepageHref());

  homepageWs.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type !== 'debug.open_im_workspace') return;

    homepageWs.send(
      JSON.stringify({
        type: 'bridge.open_im_attempt',
        bridgeId: homepageId,
        timestamp: Date.now(),
        payload: {
          method: 'window.open',
          ok: true,
          href: makeHomepageHref(),
          error: '',
        },
      })
    );

    await sleep(200);
    const imWs = await connectMockBridge(port, imId, IM_HREF);
    imWs.send(
      JSON.stringify({
        type: 'bridge.heartbeat',
        bridgeId: imId,
        timestamp: Date.now(),
        payload: { href: IM_HREF, isImWorkspace: true },
      })
    );
  });

  const imResult = await ensureDoudianImWorkspaceOpen({
    wsServer,
    bridgeTracker: tracker,
    timeoutMs: 12000,
    firstOpenDelayMs: 400,
    retryOpenIntervalMs: 400,
    noHomepageMaxWaitMs: 8000,
    openIfMissing: true,
    onOpenAttempt: (attempt) => {
      imOpenAttempts.push(attempt);
    },
  });

  const openCommandSent = imOpenAttempts.some((a) => (a.sent || []).some((s) => s.ok));
  const enterHistoryStageAfterIm = shouldEnterHistoryStage(imResult);

  await wsServer.stop();
  try {
    homepageWs.close();
  } catch {
    // ignore
  }

  return {
    openCommandSent,
    imBridgeSeen: imResult.imBridgeSeen === 1,
    enterHistoryStageAfterIm,
    imWorkspaceReason: imResult.reason,
  };
}

async function runFailurePathTest(port) {
  const wsServer = new DoudianWsServer({ port });
  await wsServer.start();

  const tracker = new BridgeTracker();
  const homepageId = 'mock-history-homepage-fail';
  const imOpenAttempts = [];

  wsServer.on('*', (envelope) => {
    tracker.recordEvent(envelope);
    if (envelope.type === 'bridge.open_im_attempt') {
      attachOpenImAttemptResponse(imOpenAttempts, envelope);
    }
  });

  const homepageWs = await connectMockBridge(port, homepageId, makeHomepageHref());
  homepageWs.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type !== 'debug.open_im_workspace') return;
    homepageWs.send(
      JSON.stringify({
        type: 'bridge.open_im_attempt',
        bridgeId: homepageId,
        timestamp: Date.now(),
        payload: { method: 'window.open', ok: true, href: makeHomepageHref(), error: '' },
      })
    );
  });

  const imResult = await ensureDoudianImWorkspaceOpen({
    wsServer,
    bridgeTracker: tracker,
    timeoutMs: 8000,
    firstOpenDelayMs: 400,
    retryOpenIntervalMs: 400,
    noHomepageMaxWaitMs: 4000,
    openIfMissing: true,
    onOpenAttempt: (attempt) => {
      imOpenAttempts.push(attempt);
    },
  });

  const enterHistoryStageAfterIm = shouldEnterHistoryStage(imResult);

  await wsServer.stop();
  try {
    homepageWs.close();
  } catch {
    // ignore
  }

  return {
    imBridgeSeen: imResult.imBridgeSeen === 1,
    enterHistoryStageAfterIm,
    imWorkspaceReason: imResult.reason,
  };
}

async function main() {
  const cfg = getDoudianConfig();
  const basePort = Number(cfg.bridgePort || 19527);
  const usesSharedEnsurer = historyUsesSharedImEnsurer();

  const successPath = await runSuccessPathTest(basePort + 21);
  const failurePath = await runFailurePathTest(basePort + 22);

  const summary = {
    success:
      usesSharedEnsurer &&
      successPath.openCommandSent &&
      successPath.imBridgeSeen &&
      successPath.enterHistoryStageAfterIm &&
      !failurePath.enterHistoryStageAfterIm &&
      failurePath.imWorkspaceReason !== 'im_bridge_seen',
    historyUsesSharedImEnsurer: usesSharedEnsurer,
    openCommandSent: successPath.openCommandSent,
    imBridgeSeen: successPath.imBridgeSeen,
    enterHistoryStageAfterIm: successPath.enterHistoryStageAfterIm,
    failurePathReason: failurePath.imWorkspaceReason,
    failureEnterHistoryStageBlocked: !failurePath.enterHistoryStageAfterIm,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.success ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({ success: false, error: err.message || String(err) }, null, 2));
  process.exit(1);
});
