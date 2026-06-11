#!/usr/bin/env node
/**
 * IM workspace 自动打开流程专项测试
 * npm run doudian:test-im-open-flow
 */
const { WebSocket } = require('ws');
const { DoudianWsServer } = require('../src/platforms/doudian/doudian-ws-server');
const { getDoudianConfig } = require('../src/shared/config');
const { WORKSPACE_URL_PATTERN } = require('../src/platforms/doudian/doudian-asar-patch-constants');
const { BridgeTracker } = require('./lib/bridge-tracker');
const {
  waitForImWorkspace,
  attachOpenImAttemptResponse,
} = require('../src/platforms/doudian/doudian-im-workspace-ensurer');
const { sleep } = require('./lib/auto-verify-utils');

const IM_HREF = `https://${WORKSPACE_URL_PATTERN}`;

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
          payload: { href, title: bridgeId },
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

async function runMockCommandDispatchTest(port) {
  const wsServer = new DoudianWsServer({ port });
  await wsServer.start();

  const bridgeId = 'mock-homepage-bridge';
  const imOpenAttempts = [];
  let openCommandReceived = false;

  const clientWs = await connectMockBridge(port, bridgeId, makeHomepageHref());

  clientWs.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type !== 'debug.open_im_workspace') return;
    openCommandReceived = true;
    clientWs.send(
      JSON.stringify({
        type: 'bridge.open_im_attempt',
        bridgeId,
        timestamp: Date.now(),
        payload: {
          method: 'window.open',
          ok: true,
          href: makeHomepageHref(),
          error: '',
        },
      })
    );
  });

  wsServer.on('*', (envelope) => {
    if (envelope.type === 'bridge.open_im_attempt') {
      attachOpenImAttemptResponse(imOpenAttempts, envelope);
    }
  });

  await sleep(200);
  const sent = wsServer.sendDebugCommand(bridgeId, 'debug.open_im_workspace', { source: 'unit_test' });
  await sleep(400);

  await wsServer.stop();
  try {
    clientWs.close();
  } catch {
    // ignore
  }

  return {
    openCommandDispatchOk: Boolean(sent && openCommandReceived),
    openAttemptEventSeen: imOpenAttempts.some((a) =>
      (a.responses || []).some((r) => r.method === 'window.open' && r.ok)
    ),
  };
}

async function runIntegratedWaitTest(port) {
  const wsServer = new DoudianWsServer({ port });
  await wsServer.start();

  const tracker = new BridgeTracker();
  const homepageId = 'mock-homepage-wait';
  const imId = 'mock-im-wait';
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

  const startedAt = Date.now();
  const imResult = await waitForImWorkspace({
    tracker,
    wsServer,
    startedAt,
    maxWaitMs: 12000,
    firstOpenDelayMs: 400,
    retryOpenIntervalMs: 400,
    noHomepageMaxWaitMs: 8000,
    onOpenAttempt: (attempt) => {
      imOpenAttempts.push(attempt);
    },
  });

  const openCommandSent = imOpenAttempts.some((a) => (a.sent || []).some((s) => s.ok));
  const openAttemptEventSeen = imOpenAttempts.some((a) =>
    (a.responses || []).some((r) => r.method === 'window.open' && r.ok)
  );

  await wsServer.stop();
  try {
    homepageWs.close();
  } catch {
    // ignore
  }

  return {
    success: Boolean(openCommandSent && openAttemptEventSeen && imResult.imBridgeSuccess),
    mock: true,
    openCommandSent,
    openAttemptEventSeen,
    imBridgeSeen: imResult.imBridgeSuccess,
    imOpenSuccess: imResult.imOpenSuccess,
    imWorkspaceReason: imResult.imWorkspaceReason,
  };
}

async function main() {
  const cfg = getDoudianConfig();
  const basePort = Number(cfg.bridgePort || 19527);

  const dispatch = await runMockCommandDispatchTest(basePort + 17);
  if (!dispatch.openCommandDispatchOk) {
    console.log(
      JSON.stringify(
        {
          success: false,
          mock: true,
          ...dispatch,
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const result = await runIntegratedWaitTest(basePort + 18);
  result.openCommandDispatchOk = dispatch.openCommandDispatchOk;

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({ success: false, error: err.message || String(err) }, null, 2));
  process.exit(1);
});
