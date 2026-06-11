const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { getDoudianWsServer } = require('../../src/platforms/doudian/doudian-ws-server');
const { DOUDIAN_EVENTS } = require('../../src/platforms/doudian/doudian-types');
const { getDoudianConfig } = require('../../src/shared/config');
const { DoudianDedupe } = require('../../src/platforms/doudian/doudian-dedupe');
const { DoudianBusinessPipeline } = require('../../src/platforms/doudian/doudian-business-pipeline');
const { closeDb } = require('../../src/platforms/doudian/doudian-data-store');
const { parseStdoutBusinessSignals, redactStdoutLine } = require('../../src/platforms/doudian/doudian-stdout-business-parser');
const { TEST_INSTALL_DIR, redactText, sleep, isDoudianRunning } = require('./auto-verify-utils');
const { ShopBridgeTracker, LISTEN_WATCH_TYPES } = require('./shop-bridge-tracker');
const { BUSINESS_PIPELINE_TYPES } = require('./doudian-listen-session');

const BRIEFING_MS = 10000;

async function runLiveSession(options = {}) {
  const cfg = getDoudianConfig();
  const bridgePort = Number(options.bridgePort || cfg.bridgePort || 19527);
  const installDir = options.installDir || TEST_INSTALL_DIR;
  const exePath = path.join(installDir, 'doudian.exe');
  const dbPath = options.dbPath || path.join(process.cwd(), 'logs', 'doudian-live.db');

  if (!fs.existsSync(exePath)) {
    throw new Error(`doudian.exe 不存在: ${exePath}`);
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  closeDb();
  process.env.DOUDIAN_VERIFY_DB = dbPath;

  const tracker = new ShopBridgeTracker();
  const dedupe = new DoudianDedupe();
  const pipeline = new DoudianBusinessPipeline({
    dedupe,
    onRealBuyerMessage: (msg) => {
      console.log(
        `[抖店桥] 捕获真实买家消息 shop=${msg.shopName || msg.shopId} conversation=${msg.conversationId || '***'} text=${msg.text || ''}`
      );
    },
  });

  const state = {
    loggedInShopCount: 0,
    activeImShopCount: 0,
    conversationCount: 0,
    realMessageCount: 0,
    insertedMessageCount: 0,
    lastMessageAt: 0,
    lastError: '',
    imBridgeReady: false,
    observerReady: false,
  };

  const wsServer = getDoudianWsServer({ port: bridgePort });
  await wsServer.start();

  const stdoutLines = [];
  const observersSent = new Set();
  const shopInfoSent = new Set();
  let lastObserverAttemptAt = 0;

  const onEvent = (envelope) => {
    if (!LISTEN_WATCH_TYPES.has(envelope.type)) return;
    tracker.recordEvent(envelope);
    if (BUSINESS_PIPELINE_TYPES.has(envelope.type)) {
      pipeline.processEnvelope(envelope);
    }
    if (envelope.type === DOUDIAN_EVENTS.MESSAGE_OBSERVER_READY) {
      state.observerReady = true;
    }
    const stats = pipeline.getStats();
    state.conversationCount = stats.conversationCount;
    state.realMessageCount = stats.realMessageCount;
    state.insertedMessageCount = stats.platformMessageInsertCount;
    state.lastMessageAt = stats.lastMessageAt;
    state.lastError = stats.lastError;
  };

  wsServer.on('*', onEvent);

  const child = spawn(exePath, [], {
    cwd: installDir,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  const onStdoutChunk = (buf) => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const redacted = redactStdoutLine(trimmed);
      if (redacted) stdoutLines.push(redacted);
    }
  };
  child.stdout.on('data', onStdoutChunk);
  child.stderr.on('data', onStdoutChunk);

  console.log('[抖店桥] 被动监听已启动，等待 IM bridge…');
  await sleep(3000);

  while (true) {
    state.imBridgeReady = tracker.hasImBridge();
    tracker.refreshShopStats();
    const shops = tracker.getAllShops();
    state.loggedInShopCount = Math.max(
      state.loggedInShopCount,
      shops.filter((s) => s.shopId || s.shopName).length,
      parseStdoutBusinessSignals(stdoutLines).loggedInShopCount
    );
    state.activeImShopCount = shops.filter((s) => s.imBridgeIds.length > 0).length;
    if (state.activeImShopCount === 0 && state.imBridgeReady) state.activeImShopCount = 1;

    const imBridgeIds = tracker.getImBridgeIds();
    for (const id of imBridgeIds) {
      if (!shopInfoSent.has(id)) {
        wsServer.sendDebugCommand(id, 'debug.get_shop_info', {});
        shopInfoSent.add(id);
      }
    }

    if (state.imBridgeReady && Date.now() - lastObserverAttemptAt > 10000) {
      for (const id of imBridgeIds) {
        if (observersSent.has(id)) continue;
        wsServer.sendDebugCommand(id, 'debug.start_message_observer', {});
        observersSent.add(id);
      }
      lastObserverAttemptAt = Date.now();
    }

    const stats = pipeline.getStats();
    console.log(
      `[抖店桥简报] loggedIn=${state.loggedInShopCount} activeIm=${state.activeImShopCount} conversations=${stats.conversationCount} realMsg=${stats.realMessageCount} inserted=${stats.platformMessageInsertCount} lastAt=${stats.lastMessageAt || 0} err=${stats.lastError || 'none'}`
    );

    await sleep(BRIEFING_MS);
  }
}

module.exports = {
  runLiveSession,
  BRIEFING_MS,
};
