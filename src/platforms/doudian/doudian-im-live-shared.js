const path = require('path');
const { spawn } = require('child_process');
const { getDoudianWsServer } = require('./doudian-ws-server');
const { DOUDIAN_EVENTS } = require('./doudian-types');
const { pickFirst } = require('./doudian-shop-utils');
const { parseStdoutBusinessSignals, redactStdoutLine } = require('./doudian-stdout-business-parser');
const {
  buildShopStatsSnapshot,
  applyShopStatsToTarget,
} = require('./doudian-shop-stats-aggregator');
const {
  resolveSelectedConversation,
  applySelectedConversationToReport,
  isConversationSelected,
  buildFallbackConversationId,
} = require('./doudian-conversation-resolver');
const {
  scanStdoutLine,
  scanWindowTitle,
  applyIntegrityWarningsToReport,
} = require('./doudian-integrity-warning-monitor');
const {
  runDoudianImWorkspacePhase,
  attachOpenImAttemptResponse,
  DEFAULT_IM_WAIT_MS,
} = require('./doudian-im-workspace-ensurer');
const {
  ShopBridgeTracker,
  LISTEN_WATCH_TYPES,
} = require('../../../scripts/lib/shop-bridge-tracker');
const { maskIdForReport, maskTextForReport } = require('./doudian-conversation-list-parser');

const DEFAULT_TIMEOUT_MINUTES = 10;
const HINTS_INTERVAL_MS = 5000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isActiveShopResolved(report) {
  const shop = (report.activeImShops || [])[0] || report.activeShop || {};
  return Boolean(String(shop.shopId || '').trim());
}

function getActiveShopContext(report) {
  const shop = (report.activeImShops || [])[0] || report.activeShop || {};
  return {
    shopId: pickFirst(shop.shopId, report.activeShop?.shopId),
    shopName: pickFirst(shop.shopName, report.activeShop?.shopName),
  };
}

function createImLiveContext(options = {}) {
  const knownShops = options.knownShops || [];
  const report = options.report || {};
  const tracker = new ShopBridgeTracker({ knownShops });
  const ctx = {
    knownShops,
    report,
    tracker,
    stdoutLines: [],
    integrityWarnings: [],
    latestDomHints: {},
    shopIdentityHints: [],
    memoryCacheHints: [],
    lastHintsAt: 0,
    handlers: [],
  };

  ctx.applyShopStats = function applyShopStats() {
    const stdoutSignal = parseStdoutBusinessSignals(ctx.stdoutLines);
    const snapshot = buildShopStatsSnapshot({
      tracker: ctx.tracker,
      stdoutSignal,
      knownShops: ctx.knownShops,
      shopIdentityHints: ctx.shopIdentityHints,
      memoryCacheHints: ctx.memoryCacheHints,
    });
    applyShopStatsToTarget(ctx.report, snapshot);
    ctx.report.imBridgeSeen = Math.max(
      ctx.report.imBridgeSeen || 0,
      snapshot.imBridgeSeen || 0,
      ctx.tracker.hasImBridge?.() ? 1 : 0,
      ctx.report.imOpenSuccess ? 1 : 0
    );
    ctx.report.activeShopResolved = isActiveShopResolved(ctx.report);
    const active = getActiveShopContext(ctx.report);
    ctx.report.shopId = active.shopId || '';
    ctx.report.shopName = active.shopName || '';
    ctx.report.activeShop = { shopId: active.shopId, shopName: active.shopName };
  };

  ctx.refreshConversationSelectionFromHints = function refreshConversationSelectionFromHints() {
    const activeShop = getActiveShopContext(ctx.report);
    const resolved = resolveSelectedConversation(
      ctx.report,
      { domHints: ctx.latestDomHints, shopId: activeShop.shopId },
      activeShop
    );
    applySelectedConversationToReport(ctx.report, resolved);
    ctx.report.buyerName = pickFirst(resolved.buyerName, ctx.report.buyerName);
    ctx.report.currentBuyerName = pickFirst(
      resolved.buyerName,
      ctx.latestDomHints.buyerName,
      ctx.latestDomHints.chatHeaderBuyerName,
      ctx.report.buyerName
    );
    ctx.report.selectedConversationDetected = isConversationSelected(resolved);
    if (!ctx.report.conversationId && resolved.buyerId && activeShop.shopId) {
      ctx.report.conversationId = buildFallbackConversationId(activeShop.shopId, resolved.buyerId);
    }
    return resolved;
  };

  ctx.handleEnvelope = function handleEnvelope(envelope) {
    if (envelope.type === 'bridge.open_im_attempt') {
      attachOpenImAttemptResponse(ctx.report.imOpenAttempts || (ctx.report.imOpenAttempts = []), envelope);
    }

    const title = envelope.payload?.title || envelope.payload?.info?.title || '';
    ctx.integrityWarnings = scanWindowTitle(title, ctx.integrityWarnings);

    if (LISTEN_WATCH_TYPES.has(envelope.type)) {
      ctx.tracker.recordEvent(envelope);
    }

    const p = envelope.payload || {};

    if (envelope.type === DOUDIAN_EVENTS.SHOP_IDENTITY_RESOLVED) {
      ctx.shopIdentityHints.push({
        shopId: pickFirst(p.shopId, p.shopInfo?.shopId),
        shopName: pickFirst(p.shopName, p.shopInfo?.shopName),
        bridgeId: envelope.bridgeId,
      });
    }
    if (envelope.type === DOUDIAN_EVENTS.MEMORY_CACHE_CANDIDATE) {
      ctx.memoryCacheHints.push({
        shopId: pickFirst(p.shopId, p.shopInfo?.shopId),
        shopName: pickFirst(p.shopName, p.shopInfo?.shopName),
        bridgeId: envelope.bridgeId,
      });
    }
    if (envelope.type === DOUDIAN_EVENTS.CHAT_CONVERSATION_HINTS) {
      const hints = p.hints || p.selectedConversation || {};
      if (hints && Object.keys(hints).length) {
        ctx.latestDomHints = { ...ctx.latestDomHints, ...hints };
        ctx.refreshConversationSelectionFromHints();
      }
    }

    for (const fn of ctx.handlers) {
      try {
        fn(envelope, p);
      } catch {
        // ignore handler errors
      }
    }
  };

  return ctx;
}

async function bootstrapImLiveClient(options = {}) {
  const {
    installDir,
    bridgePort,
    report,
    ctx,
    logLabel = 'im-live',
    timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
    keepClientAlive = false,
  } = options;
  const exePath = path.join(installDir, 'doudian.exe');
  const wsServer = getDoudianWsServer({ port: bridgePort });
  const { startBridgeWsServer } = require('../../../scripts/lib/auto-verify-utils');
  const wsStarted = await startBridgeWsServer(wsServer, report);
  if (!wsStarted) {
    return { ok: false, wsServer, child: null, reason: report.reason || 'ws_start_failed' };
  }
  wsServer.on('*', ctx.handleEnvelope);

  const child = spawn(exePath, [], {
    cwd: installDir,
    detached: keepClientAlive,
    stdio: keepClientAlive ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  if (!keepClientAlive) {
    const onStdoutChunk = (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const redacted = redactStdoutLine(trimmed);
        if (redacted) {
          ctx.stdoutLines.push(redacted);
          ctx.integrityWarnings = scanStdoutLine(redacted, ctx.integrityWarnings);
        }
      }
    };
    child.stdout.on('data', onStdoutChunk);
    child.stderr.on('data', onStdoutChunk);
  }
  if (keepClientAlive) {
    child.unref();
  }

  console.log(`[抖店桥] ${logLabel} 已启动，超时 ${timeoutMinutes} 分钟`);
  await sleep(3000);

  const imResult = await runDoudianImWorkspacePhase({
    wsServer,
    bridgeTracker: ctx.tracker,
    report,
    timeoutMs: DEFAULT_IM_WAIT_MS,
    openIfMissing: true,
    onTick: () => {
      ctx.applyShopStats();
      applyIntegrityWarningsToReport(report, ctx.integrityWarnings);
    },
    logPrefix: '[抖店桥]',
  });

  applyIntegrityWarningsToReport(report, ctx.integrityWarnings);
  if (imResult.imBridgeSeen !== 1) {
    return { ok: false, wsServer, child, reason: 'im_workspace_not_opened' };
  }

  return { ok: true, wsServer, child, reason: '' };
}

function sanitizeLiveReport(report) {
  return {
    ...report,
    conversationId: maskIdForReport(report.conversationId),
    buyerId: maskIdForReport(report.buyerId),
    text: report.text ? maskTextForReport(report.text) : report.text,
  };
}

module.exports = {
  sleep,
  isActiveShopResolved,
  getActiveShopContext,
  createImLiveContext,
  bootstrapImLiveClient,
  sanitizeLiveReport,
  DEFAULT_TIMEOUT_MINUTES,
  HINTS_INTERVAL_MS,
  DEFAULT_IM_WAIT_MS,
};
