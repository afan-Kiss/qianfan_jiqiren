const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { getDoudianWsServer } = require('../../src/platforms/doudian/doudian-ws-server');
const { DOUDIAN_EVENTS } = require('../../src/platforms/doudian/doudian-types');
const { getDoudianConfig } = require('../../src/shared/config');
const { WORKSPACE_URL_PATTERN } = require('../../src/platforms/doudian/doudian-asar-patch-constants');
const { DoudianDedupe } = require('../../src/platforms/doudian/doudian-dedupe');
const { normalizeInboundMessage } = require('../../src/platforms/doudian/doudian-normalizer');
const { insertMessage, insertCaptureCandidate, closeDb } = require('../../src/platforms/doudian/doudian-data-store');
const {
  maskMessageForReport,
  buildShopKey,
  maskAccountId,
  pickFirst,
} = require('../../src/platforms/doudian/doudian-shop-utils');
const { isUiNoise } = require('../../src/platforms/doudian/doudian-ui-noise-filter');
const { isRealMessageCandidate, resolveApiName } = require('../../src/platforms/doudian/doudian-pigeon-parser');
const { parseStdoutBusinessSignals, redactStdoutLine } = require('../../src/platforms/doudian/doudian-stdout-business-parser');
const {
  TEST_INSTALL_DIR,
  redactText,
  sleep,
  isDoudianRunning,
} = require('./auto-verify-utils');
const { DoudianBusinessPipeline } = require('../../src/platforms/doudian/doudian-business-pipeline');
const { ShopBridgeTracker, LISTEN_WATCH_TYPES } = require('./shop-bridge-tracker');
const {
  buildShopStatsSnapshot,
  applyShopStatsToTarget,
} = require('../../src/platforms/doudian/doudian-shop-stats-aggregator');

const LISTEN_WAIT_MS = 180000;

const BUSINESS_PIPELINE_TYPES = new Set([
  DOUDIAN_EVENTS.MEMORY_CACHE_CANDIDATE,
  DOUDIAN_EVENTS.SHOP_IDENTITY_RESOLVED,
  DOUDIAN_EVENTS.CONVERSATION_LIST,
  DOUDIAN_EVENTS.MESSAGE_REAL_CANDIDATE,
  DOUDIAN_EVENTS.CONVERSATION_EMPTY,
]);

function maskSampleText(text) {
  let s = String(text || '').slice(0, 200);
  s = s.replace(/1\d{10}/g, (m) => `${m.slice(0, 3)}****${m.slice(-4)}`);
  s = s.replace(/\d{15,20}/g, (m) => `${m.slice(0, 4)}****${m.slice(-4)}`);
  return s;
}

function extractPayloadShop(envelope) {
  const p = envelope.payload || {};
  const shopInfo = p.shopInfo || p.info || {};
  return {
    shopId: pickFirst(p.shopId, shopInfo.shopId, p.shopHints?.shopId),
    shopName: pickFirst(p.shopName, shopInfo.shopName, p.shopHints?.shopName),
    accountId: pickFirst(p.accountId, shopInfo.accountId),
    sessionPartitionKey: pickFirst(p.sessionPartitionKey, shopInfo.sessionPartitionKey),
    shopIdentitySource: pickFirst(p.shopIdentitySource, shopInfo.shopIdentitySource, p.source, p.bridgeType),
  };
}

function hasBusinessApiSignal(result) {
  const apiNames = new Set((result.pigeonApiSignals || []).map((s) => s.apiName));
  const hasPigeonApi = ['currentuser', 'get_current_conversation_list', 'get_link_info'].some((a) =>
    apiNames.has(a)
  );
  return (
    result.currentUserCaptured ||
    result.conversationListCaptured ||
    result.linkInfoCaptured ||
    result.workerNetworkCandidateCount > 0 ||
    result.memoryCacheCandidateCount > 0 ||
    hasPigeonApi ||
    (result.stdoutBusinessSignal?.apiSignals?.length > 0 && result.stdoutBusinessSignalCount > 0)
  );
}

function computeSuccess(result) {
  const bridgeSuccess = Boolean(result.imBridgeSuccess);
  const observerReady = result.observerReadyCount > 0;
  const shopIdentitySuccess = Boolean(result.shopIdentitySuccess);
  const businessDataCaptured = hasBusinessApiSignal(result);
  const realMessageCandidateCaptured = result.realMessageCandidateCount > 0;
  const onlyUiNoiseCaptured =
    result.uiNoiseCount > 0 &&
    !businessDataCaptured &&
    !realMessageCandidateCaptured &&
    !result.emptyStateDetected &&
    result.domCandidateCount === 0;

  const success =
    bridgeSuccess &&
    observerReady &&
    shopIdentitySuccess &&
    (businessDataCaptured ||
      result.conversationEmptyEventCount > 0 ||
      result.realMessageCandidateEventCount > 0);

  return {
    bridgeSuccess,
    observerReady,
    shopIdentitySuccess,
    businessDataCaptured,
    realMessageCandidateCaptured,
    onlyUiNoiseCaptured,
    success,
  };
}

async function runListenSession(options = {}) {
  const cfg = getDoudianConfig();
  const knownShops = cfg.knownShops || [];
  const bridgePort = Number(options.bridgePort || cfg.bridgePort || 19527);
  const installDir = options.installDir || TEST_INSTALL_DIR;
  const exePath = path.join(installDir, 'doudian.exe');
  const waitMs = Number(options.waitMs || LISTEN_WAIT_MS);
  const verifyDbPath = options.verifyDbPath || path.join(process.cwd(), 'logs', 'doudian-listen-verify.db');

  const tracker = new ShopBridgeTracker({ knownShops });
  const dedupe = new DoudianDedupe();
  const pipeline = new DoudianBusinessPipeline({ dedupe });
  const bridgeShopState = new Map();
  const stdoutLines = [];
  const memoryCacheHints = [];

  const result = {
    ok: false,
    success: false,
    bridgeSuccess: false,
    observerReady: false,
    shopIdentitySuccess: false,
    businessDataCaptured: false,
    realMessageCandidateCaptured: false,
    onlyUiNoiseCaptured: false,
    multiShopDetected: false,
    shopCount: 0,
    loggedInShopCount: 0,
    activeImShopCount: 0,
    inactiveShopCount: 0,
    loggedInShops: [],
    activeImShops: [],
    inactiveShops: [],
    unknownImBridges: [],
    shops: [],
    unknownBridges: [],
    allBridges: [],
    homepageBridgeSuccess: false,
    imBridgeSuccess: false,
    observerStartedCount: 0,
    observerReadyCount: 0,
    shopIdentityResolvedCount: 0,
    imDomDiagnosticCount: 0,
    emptyStateDetected: false,
    conversationEmptyDetected: false,
    networkReplayCount: 0,
    networkShopInfoCount: 0,
    domCandidateCount: 0,
    domCandidateSamples: [],
    networkCandidateSamples: [],
    shopIdentitySamples: [],
    unresolvedImBridges: [],
    domDiagnosticSuccess: false,
    messageCandidateSuccess: false,
    sqliteInsertSuccess: true,
    normalizedMessageCount: 0,
    dedupedMessageCount: 0,
    insertedMessageCount: 0,
    sampleMessages: [],
    uiNoiseCount: 0,
    uiNoiseSamples: [],
    workerNetworkCandidateCount: 0,
    memoryCacheCandidateCount: 0,
    stdoutBusinessSignalCount: 0,
    pigeonApiSignals: [],
    currentUserCaptured: false,
    conversationListCaptured: false,
    linkInfoCaptured: false,
    realConversationCount: 0,
    realMessageCandidateCount: 0,
    realMessageSamples: [],
    stdoutBusinessSignal: null,
    memoryCacheBusinessEventCount: 0,
    shopIdentityEventCount: 0,
    conversationListEventCount: 0,
    conversationEmptyEventCount: 0,
    realMessageCandidateEventCount: 0,
    platformConversationUpsertCount: 0,
    platformMessageInsertCount: 0,
    parserFixtureSuggested: true,
    imOpenAttempts: [],
    listenWaitMs: waitMs,
    bridgePort,
    installDir,
    wsStarted: false,
    clientStarted: false,
    errors: [],
    warnings: [],
    nextActions: [],
    failStep: '',
  };

  if (!fs.existsSync(exePath)) {
    result.errors.push(`测试版 doudian.exe 不存在: ${exePath}`);
    result.failStep = 'ws_server_error';
    return result;
  }

  fs.mkdirSync(path.dirname(verifyDbPath), { recursive: true });
  if (fs.existsSync(verifyDbPath)) fs.unlinkSync(verifyDbPath);
  closeDb();
  process.env.DOUDIAN_VERIFY_DB = verifyDbPath;

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

  function recordCaptureCandidate(record) {
    try {
      insertCaptureCandidate(record);
    } catch (err) {
      result.sqliteInsertSuccess = false;
      if (result.errors.length < 20) result.errors.push(`capture_candidate 入库失败: ${err.message || err}`);
    }
  }

  function markApiCaptured(apiName) {
    if (apiName === 'currentuser') result.currentUserCaptured = true;
    if (apiName === 'get_current_conversation_list') result.conversationListCaptured = true;
    if (apiName === 'get_link_info') result.linkInfoCaptured = true;
    if (!result.pigeonApiSignals.some((s) => s.apiName === apiName)) {
      result.pigeonApiSignals.push({ apiName, source: 'bridge' });
    }
  }

  function addRealMessageSample(sample) {
    result.realMessageCandidateCount += 1;
    if (result.realMessageSamples.length < 10) {
      result.realMessageSamples.push({
        shopId: sample.shopId || '',
        shopName: sample.shopName || '',
        text: maskSampleText(sample.text),
        conversationId: sample.conversationId ? `${String(sample.conversationId).slice(0, 6)}***` : '',
        buyerName: maskSampleText(sample.buyerName || ''),
        source: sample.source || '',
      });
    }
  }

  function updateBridgeShop(envelope) {
    const shop = extractPayloadShop(envelope);
    const bridgeId = envelope.bridgeId || '';
    if (!bridgeId) return shop;
    const prev = bridgeShopState.get(bridgeId) || {};
    const merged = {
      shopId: pickFirst(shop.shopId, prev.shopId),
      shopName: pickFirst(shop.shopName, prev.shopName),
      accountId: pickFirst(shop.accountId, prev.accountId),
      sessionPartitionKey: pickFirst(shop.sessionPartitionKey, prev.sessionPartitionKey),
      shopIdentitySource: pickFirst(shop.shopIdentitySource, prev.shopIdentitySource, 'unknown'),
    };
    bridgeShopState.set(bridgeId, merged);
    if (merged.shopId || merged.shopName) {
      if (result.shopIdentitySamples.length < 10) {
        result.shopIdentitySamples.push({
          bridgeId: `${bridgeId.slice(0, 16)}...`,
          shopId: merged.shopId,
          shopName: merged.shopName,
          shopIdentitySource: merged.shopIdentitySource,
          type: envelope.type,
        });
      }
    }
    return merged;
  }

  function handleFormalMessage(envelope) {
    if (envelope.type !== DOUDIAN_EVENTS.MESSAGE_INBOUND && envelope.type !== DOUDIAN_EVENTS.MESSAGE_OUTBOUND) {
      return;
    }
    const normalized = normalizeInboundMessage(envelope);
    if (isUiNoise(normalized.text)) return;
    if (!isRealMessageCandidate(normalized)) return;
    result.normalizedMessageCount += 1;
    if (dedupe.isDuplicate(normalized)) {
      result.dedupedMessageCount += 1;
      return;
    }
    try {
      insertMessage(normalized);
      result.insertedMessageCount += 1;
      if (result.sampleMessages.length < 5) result.sampleMessages.push(maskMessageForReport(normalized));
    } catch (err) {
      result.sqliteInsertSuccess = false;
      result.errors.push(`SQLite 入库失败: ${err.message || err}`);
      result.failStep = result.failStep || 'sqlite_insert_failed';
    }
  }
  const onEvent = (envelope) => {
    if (!LISTEN_WATCH_TYPES.has(envelope.type)) return;
    tracker.recordEvent(envelope);
    const shop = updateBridgeShop(envelope);
    const p = envelope.payload || {};

    console.log(`[listen-event] ${JSON.stringify({
      type: envelope.type,
      bridgeId: envelope.bridgeId,
      shopId: shop.shopId,
      shopName: shop.shopName,
      source: shop.shopIdentitySource,
    })}`);

    if (envelope.type === DOUDIAN_EVENTS.MESSAGE_OBSERVER_READY) {
      result.observerReadyCount += 1;
      if (shop.shopId || shop.shopName) result.shopIdentityResolvedCount += 1;
    }

    if (envelope.type === DOUDIAN_EVENTS.SHOP_DETECTED && (shop.shopId || shop.shopName)) {
      if (p.href && String(p.href).includes(WORKSPACE_URL_PATTERN)) {
        result.shopIdentityResolvedCount += 1;
      }
    }

    if (envelope.type === DOUDIAN_EVENTS.IM_DOM_DIAGNOSTIC) {
      result.imDomDiagnosticCount += 1;
      if (shop.shopId || shop.shopName) result.shopIdentityResolvedCount += 1;
    }

    if (envelope.type === DOUDIAN_EVENTS.IM_EMPTY_STATE) {
      result.emptyStateDetected = true;
      result.domDiagnosticSuccess = true;
    }

    if (envelope.type === DOUDIAN_EVENTS.CONVERSATION_EMPTY) {
      result.conversationEmptyDetected = true;
      result.emptyStateDetected = true;
      markApiCaptured('get_current_conversation_list');
    }

    if (BUSINESS_PIPELINE_TYPES.has(envelope.type)) {
      pipeline.processEnvelope(envelope);
      if (envelope.type === DOUDIAN_EVENTS.MEMORY_CACHE_CANDIDATE) {
        result.memoryCacheCandidateCount += 1;
        const shopInfo = p.shopInfo || {};
        memoryCacheHints.push({
          bridgeId: envelope.bridgeId,
          cacheKey: p.cacheKey || '',
          apiName: p.apiName || resolveApiName(p.cacheKey || ''),
          shopId: pickFirst(p.shopId, shopInfo.shopId),
          shopName: pickFirst(p.shopName, shopInfo.shopName),
          sessionPartitionKey: pickFirst(p.sessionPartitionKey, shopInfo.sessionPartitionKey),
          accountId: pickFirst(p.accountId, shopInfo.accountId),
          source: 'memory_cache',
        });
        const apiName = p.apiName || resolveApiName(p.cacheKey || '');
        markApiCaptured(apiName);
        if (p.shopInfo?.shopId || p.shopInfo?.shopName) {
          result.networkShopInfoCount += 1;
          result.shopIdentityResolvedCount += 1;
        }
        result.realConversationCount = Math.max(
          result.realConversationCount,
          Number(p.conversationCount || 0),
          pipeline.getStats().conversationCount
        );
      }
    }

    if (envelope.type === DOUDIAN_EVENTS.UI_NOISE) {
      result.uiNoiseCount += 1;
      if (result.uiNoiseSamples.length < 10) {
        result.uiNoiseSamples.push(maskSampleText(p.text));
      }
      recordCaptureCandidate({
        captureType: 'ui_noise',
        isUiNoise: true,
        text: maskSampleText(p.text),
        source: 'dom',
        bridgeType: p.bridgeType || 'preload',
        bridgeId: envelope.bridgeId,
        pageHref: p.pageHref || '',
      });
    }

    if (envelope.type === DOUDIAN_EVENTS.NETWORK_BUFFER_REPLAY) {
      result.networkReplayCount += 1;
      const items = Array.isArray(p.items) ? p.items : [];
      for (const item of items) {
        if (item.shopHints?.shopId || item.shopHints?.shopName) result.networkShopInfoCount += 1;
      }
      if (p.shopInfo?.shopId || p.shopInfo?.shopName) result.shopIdentityResolvedCount += 1;
    }

    if (envelope.type === DOUDIAN_EVENTS.MESSAGE_NETWORK_CANDIDATE) {
      const apiName = resolveApiName(p.urlPath || p.url || '');
      if (apiName !== 'unknown') markApiCaptured(apiName);
      if (shop.shopId || shop.shopName || p.shopHints?.shopId) result.networkShopInfoCount += 1;
      const text = maskSampleText(p.text || p.textSample);
      const real = !isUiNoise(text) && isRealMessageCandidate({ text, conversationId: p.shopHints?.conversationId });
      if (real) addRealMessageSample({ text, shopId: shop.shopId, shopName: shop.shopName, source: 'network' });
      if (result.networkCandidateSamples.length < 10) {
        result.networkCandidateSamples.push({
          shopId: shop.shopId || p.shopHints?.shopId || '',
          shopName: shop.shopName || p.shopHints?.shopName || '',
          text,
          urlPath: String(p.urlPath || '').slice(0, 120),
          apiName,
        });
      }
      recordCaptureCandidate({
        captureType: 'network_candidate',
        isRealMessageCandidate: real,
        apiName,
        shopId: shop.shopId || p.shopHints?.shopId || '',
        shopName: shop.shopName || p.shopHints?.shopName || '',
        text,
        source: p.source || 'network',
        bridgeType: p.bridgeType || 'preload',
        bridgeId: envelope.bridgeId,
      });
    }

    if (envelope.type === DOUDIAN_EVENTS.WORKER_NETWORK_CANDIDATE) {
      result.workerNetworkCandidateCount += 1;
      const apiName = p.apiName || resolveApiName(p.url || '');
      markApiCaptured(apiName);
      result.realConversationCount = Math.max(result.realConversationCount, Number(p.conversationCount || 0));
      if (p.shopInfo?.shopId || p.shopInfo?.shopName) result.networkShopInfoCount += 1;
      if (Array.isArray(p.items)) {
        for (const item of p.items) {
          if (item.text && isRealMessageCandidate(item)) {
            addRealMessageSample({ ...item, shopId: p.shopInfo?.shopId, shopName: p.shopInfo?.shopName, source: 'rust_worker' });
          }
        }
      }
      recordCaptureCandidate({
        captureType: 'worker_network',
        apiName,
        shopId: p.shopInfo?.shopId || '',
        shopName: p.shopInfo?.shopName || '',
        source: p.source || 'rust_worker',
        bridgeType: p.bridgeType || 'rust_worker',
        bridgeId: envelope.bridgeId,
        raw: { url: p.url, conversationCount: p.conversationCount, messageCount: p.messageCount },
      });
    }

    if (envelope.type === DOUDIAN_EVENTS.MESSAGE_DOM_CANDIDATE) {
      const text = maskSampleText(p.text);
      if (isUiNoise(text)) {
        result.uiNoiseCount += 1;
        if (result.uiNoiseSamples.length < 10) result.uiNoiseSamples.push(text);
        recordCaptureCandidate({
          captureType: 'dom_candidate',
          isUiNoise: true,
          text,
          source: 'dom',
          bridgeId: envelope.bridgeId,
          pageHref: p.pageHref || '',
        });
        return;
      }
      result.domCandidateCount += 1;
      const real = Boolean(p.isRealMessageCandidate) && isRealMessageCandidate({ text, conversationId: p.conversationId, messageId: p.messageId, buyerId: p.buyerId });
      if (real) addRealMessageSample({ text, shopId: shop.shopId, shopName: shop.shopName, source: 'dom' });
      if (result.domCandidateSamples.length < 10) {
        result.domCandidateSamples.push({
          shopId: shop.shopId,
          shopName: shop.shopName,
          text,
          selectorHint: String(p.selectorHint || '').slice(0, 80),
          isRealMessageCandidate: real,
        });
      }
      recordCaptureCandidate({
        captureType: 'dom_candidate',
        isRealMessageCandidate: real,
        shopId: shop.shopId || '',
        shopName: shop.shopName || '',
        text,
        source: 'dom',
        bridgeId: envelope.bridgeId,
        pageHref: p.pageHref || '',
      });
    }

    handleFormalMessage(envelope);
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

  const onStdoutChunk = (buf) => {
    const chunk = buf.toString('utf8');
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const redacted = redactStdoutLine(trimmed);
      if (redacted) stdoutLines.push(redacted);
      const safeLine = redactText(trimmed);
      if (safeLine && /im\.jinritemai\.com|window open im|pc_seller_desk_v2|pigeon\.jinritemai|write memory cache|init window with accounts/i.test(safeLine)) {
        if (result.warnings.length < 30) result.warnings.push(`stdout-hint: ${safeLine.slice(0, 120)}`);
      }
    }
  };

  child.stdout.on('data', onStdoutChunk);
  child.stderr.on('data', onStdoutChunk);

  await sleep(3000);
  result.doudianRunningAfterStart = isDoudianRunning().length > 0;

  const started = Date.now();
  const observersSent = new Set();
  const shopInfoSent = new Set();
  let lastObserverAttemptAt = 0;

  while (Date.now() - started < waitMs) {
    result.homepageBridgeSuccess = tracker.hasHomepageBridge();
    result.imBridgeSuccess = tracker.hasImBridge();
    result.bridgeSuccess = result.imBridgeSuccess;

    const imBridgeIds = tracker.getImBridgeIds();
    for (const id of imBridgeIds) {
      if (!shopInfoSent.has(id)) {
        wsServer.sendDebugCommand(id, 'debug.get_shop_info', {});
        shopInfoSent.add(id);
      }
    }

    if (result.imBridgeSuccess && Date.now() - lastObserverAttemptAt > 10000) {
      tracker.refreshShopStats();
      for (const id of imBridgeIds) {
        if (observersSent.has(id)) continue;
        const ok = wsServer.sendDebugCommand(id, 'debug.start_message_observer', {});
        result.imOpenAttempts.push({
          at: Date.now(),
          type: 'debug.start_message_observer',
          bridgeId: id,
          ok: Boolean(ok),
        });
        observersSent.add(id);
        result.observerStartedCount += 1;
        console.log(`[listen] start observer -> ${id} ok=${Boolean(ok)}`);
      }
      lastObserverAttemptAt = Date.now();
    }

    const metrics = computeSuccess({
      imBridgeSuccess: result.imBridgeSuccess,
      observerReadyCount: result.observerReadyCount,
      shopIdentitySuccess: result.shopIdentityResolvedCount > 0,
      ...result,
    });

    if (metrics.success && Date.now() - started > 30000) break;
    if (
      result.imBridgeSuccess &&
      result.observerReadyCount > 0 &&
      Date.now() - started > 90000 &&
      (hasBusinessApiSignal(result) || result.emptyStateDetected || result.onlyUiNoiseCaptured)
    ) {
      break;
    }

    await sleep(2000);
  }

  result.waitMs = Date.now() - started;
  tracker.refreshShopStats();

  const stdoutSignal = parseStdoutBusinessSignals(stdoutLines);
  result.stdoutBusinessSignal = stdoutSignal;
  result.stdoutBusinessSignalCount = stdoutSignal.apiSignals.length + stdoutSignal.shopIds.length;
  for (const sig of stdoutSignal.pigeonApiSignals) {
    markApiCaptured(sig.apiName);
    if (!result.pigeonApiSignals.some((s) => s.apiName === sig.apiName && s.source === sig.source)) {
      result.pigeonApiSignals.push(sig);
    }
  }

  const shopMap = new Map();
  for (const [bridgeId, state] of bridgeShopState.entries()) {
    const bridge = tracker.bridges.get(bridgeId);
    const shopKey = buildShopKey({ ...state, bridgeId });
    let shop = shopMap.get(shopKey);
    if (!shop) {
      shop = {
        shopKey,
        shopId: state.shopId || '',
        shopName: state.shopName || '',
        accountId: state.accountId || '',
        accountIdMasked: maskAccountId(state.accountId),
        sessionPartitionKey: state.sessionPartitionKey || '',
        shopIdentitySource: state.shopIdentitySource || 'unknown',
        shopIdResolved: Boolean(state.shopId),
        shopNameResolved: Boolean(state.shopName),
        homepageBridgeIds: [],
        imBridgeIds: [],
        activeImBridgeId: '',
        observerReady: false,
        domSnapshotCount: 0,
        domAddedCount: 0,
        networkCandidateCount: 0,
        domDiagnosticCount: 0,
        domCandidateCount: 0,
        emptyStateDetected: false,
        normalizedMessageCount: 0,
        insertedMessageCount: 0,
        sampleMessages: [],
      };
      shopMap.set(shopKey, shop);
    }
    if (bridge?.isHomepage) shop.homepageBridgeIds.push(bridgeId);
    if (bridge?.isImWorkspace) shop.imBridgeIds.push(bridgeId);
    if (bridge?.observerReady) shop.observerReady = true;
    shop.shopId = shop.shopId || state.shopId;
    shop.shopName = shop.shopName || state.shopName;
    shop.shopIdResolved = Boolean(shop.shopId);
    shop.shopNameResolved = Boolean(shop.shopName);
  }

  for (const sample of result.domCandidateSamples) {
    for (const shop of shopMap.values()) {
      if (sample.shopId && sample.shopId === shop.shopId) shop.domCandidateCount += 1;
      else if (sample.shopName && sample.shopName === shop.shopName) shop.domCandidateCount += 1;
    }
  }

  result.allBridges = tracker.getAllBridges();
  result.unknownBridges = tracker.unknownBridges;
  result.shops = [...shopMap.values()];
  result.shopCount = result.shops.filter((s) => {
    const name = s.shopName || '';
    if (!s.shopId && !name) return false;
    if (/^(首页|抖店|飞鸽客服系统)$/.test(name) && !s.shopId) return false;
    return true;
  }).length;

  const shopIdentityHints = result.shopIdentitySamples.map((sample) => ({
    shopId: sample.shopId,
    shopName: sample.shopName,
    sessionPartitionKey: sample.sessionPartitionKey,
    source: sample.source || 'memory_cache',
  }));
  const shopStats = buildShopStatsSnapshot({
    tracker,
    stdoutSignal,
    knownShops,
    shopIdentityHints,
    memoryCacheHints,
  });
  applyShopStatsToTarget(result, shopStats);
  result.multiShopDetected = result.loggedInShopCount >= 2 || result.shopCount >= 2;

  for (const b of result.allBridges.filter((x) => x.isImWorkspace)) {
    const st = bridgeShopState.get(b.bridgeId);
    if (!st?.shopId && !st?.shopName) {
      result.unresolvedImBridges.push({
        bridgeId: b.bridgeId,
        hrefs: b.hrefs,
        observerReady: b.observerReady,
      });
    }
  }

  result.shopIdentitySuccess = result.shopIdentityResolvedCount > 0 || result.shops.some((s) => s.shopIdResolved);
  result.domDiagnosticSuccess = result.imDomDiagnosticCount > 0 || result.emptyStateDetected;
  result.messageCandidateSuccess = result.realMessageCandidateCount > 0 || hasBusinessApiSignal(result);

  const pipeStats = pipeline.getStats();
  Object.assign(result, {
    memoryCacheBusinessEventCount: pipeStats.memoryCacheBusinessEventCount,
    shopIdentityEventCount: pipeStats.shopIdentityEventCount,
    conversationListEventCount: pipeStats.conversationListEventCount,
    conversationEmptyEventCount: pipeStats.conversationEmptyEventCount,
    realMessageCandidateEventCount: pipeStats.realMessageCandidateEventCount,
    platformConversationUpsertCount: pipeStats.platformConversationUpsertCount,
    platformMessageInsertCount: pipeStats.platformMessageInsertCount,
  });
  result.realConversationCount = Math.max(result.realConversationCount, pipeStats.conversationCount);
  if (pipeStats.realMessageCandidateEventCount > 0) {
    result.realMessageCandidateCaptured = true;
  }
  if (pipeStats.conversationEmptyEventCount > 0) {
    result.conversationEmptyDetected = true;
    result.emptyStateDetected = true;
  }

  const finalMetrics = computeSuccess({
    imBridgeSuccess: result.imBridgeSuccess,
    observerReadyCount: result.observerReadyCount,
    shopIdentitySuccess: result.shopIdentitySuccess,
    ...result,
  });
  Object.assign(result, finalMetrics);
  result.observerReady = result.observerReadyCount > 0;
  result.ok = result.success;

  if (!result.imBridgeSuccess) result.failStep = 'im_bridge_not_seen';
  else if (!result.shopIdentitySuccess) result.failStep = 'shop_identity_missing';
  else if (result.observerStartedCount === 0) result.failStep = 'observer_start_failed';
  else if (result.observerReadyCount === 0) result.failStep = 'observer_start_failed';
  else if (result.onlyUiNoiseCaptured && !result.businessDataCaptured && !result.emptyStateDetected) {
    result.failStep = 'only_ui_noise_captured';
  } else if (!result.success) result.failStep = result.failStep || 'business_data_not_captured';

  if (result.loggedInShopCount >= 2 && result.activeImShopCount < result.loggedInShopCount) {
    result.warnings.push(
      `已登录 ${result.loggedInShopCount} 个店铺，当前 IM 仅激活 ${result.activeImShopCount} 个（inactive=${result.inactiveShopCount}）`
    );
    for (const inactive of result.inactiveShops || []) {
      const ks = knownShops.find((k) => k.shopId === inactive.shopId);
      if (!ks) continue;
      result.warnings.push(
        `检测到第二店铺「${ks.shopName}」已登录但未激活 IM 页；后续需要做只读切换诊断或用户手动切换后再验证。`
      );
    }
  }
  if (result.uiNoiseCount > 0 && !result.realMessageCandidateCaptured) {
    result.warnings.push(`捕获 ${result.uiNoiseCount} 条 UI 噪音，已过滤，不计入消息成功`);
  }
  if (result.domCandidateCount === 0 && !result.emptyStateDetected && !result.businessDataCaptured) {
    result.warnings.push('未捕获真实 dom_candidate，也未识别 empty_state / 业务 API');
  }
  if (result.emptyStateDetected) {
    result.warnings.push('IM 页为空会话状态（暂无会话中用户/请选择会话），属于正常情况');
  }
  if (result.stdoutBusinessSignalCount > 0 && !result.memoryCacheCandidateCount && !result.workerNetworkCandidateCount) {
    result.warnings.push('stdout 已见 memory cache 信号，但 IPC/worker hook 尚未回传响应体，需继续 patch');
  }

  result.nextActions = result.success
    ? [
        '业务数据捕获链路已打通，可继续精修 conversation/message 解析',
        '如需第二店铺 IM，后续做只读店铺切换诊断（不自动点击）',
      ]
    : result.onlyUiNoiseCaptured
      ? [
          'DOM 诊断成功但仅 UI 噪音，请依赖 worker/memory cache/stdout 捕获 pigeon 数据',
          '确认 rust_im_worker_index.js patch 已写入测试目录 asar',
          '重跑 npm run doudian:auto-verify-listen',
        ]
      : [
          '检查 pigeon IPC getMemoryCacheData hook 与 rust worker network hook',
          '确认 patch force 重写到测试目录',
          '重跑 npm run doudian:auto-verify-listen',
        ];

  try {
    child.unref();
  } catch {
    // ignore
  }

  return result;
}

module.exports = {
  runListenSession,
  LISTEN_WAIT_MS,
  computeSuccess,
  BUSINESS_PIPELINE_TYPES,
};
