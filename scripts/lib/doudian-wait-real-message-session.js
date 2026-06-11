const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { getDoudianWsServer } = require('../../src/platforms/doudian/doudian-ws-server');
const { DOUDIAN_EVENTS } = require('../../src/platforms/doudian/doudian-types');
const { getDoudianConfig } = require('../../src/shared/config');
const { DoudianDedupe } = require('../../src/platforms/doudian/doudian-dedupe');
const { DoudianBusinessPipeline } = require('../../src/platforms/doudian/doudian-business-pipeline');
const {
  insertMessage,
  getLastInsertedMessage,
  getMessageById,
  closeDb,
} = require('../../src/platforms/doudian/doudian-data-store');
const {
  isRealBuyerMessage,
  toNormalizedMessage,
} = require('../../src/platforms/doudian/doudian-real-message-detector');
const { maskMessageForReport, pickFirst } = require('../../src/platforms/doudian/doudian-shop-utils');
const { parseStdoutBusinessSignals, redactStdoutLine } = require('../../src/platforms/doudian/doudian-stdout-business-parser');
const {
  buildShopStatsSnapshot,
  applyShopStatsToTarget,
} = require('../../src/platforms/doudian/doudian-shop-stats-aggregator');
const { resolveApiName } = require('../../src/platforms/doudian/doudian-pigeon-parser');
const {
  TEST_INSTALL_DIR,
  redactText,
  sleep,
  writeReports,
} = require('./auto-verify-utils');
const { ShopBridgeTracker, LISTEN_WATCH_TYPES } = require('./shop-bridge-tracker');
const { BUSINESS_PIPELINE_TYPES } = require('./doudian-listen-session');
const {
  runDoudianImWorkspacePhase,
  attachOpenImAttemptResponse,
  DEFAULT_IM_WAIT_MS,
} = require('../../src/platforms/doudian/doudian-im-workspace-ensurer');
const {
  scanStdoutLine,
  scanWindowTitle,
  applyIntegrityWarningsToReport,
} = require('../../src/platforms/doudian/doudian-integrity-warning-monitor');

const BRIEFING_MS = 10000;
const DEFAULT_TIMEOUT_MINUTES = 30;

function applyBridgeClassificationToReport(report, tracker) {
  const counts =
    typeof tracker.getBridgeClassificationCounts === 'function'
      ? tracker.getBridgeClassificationCounts()
      : {
          homepageBridgeSeen: tracker.hasHomepageBridge?.() ? 1 : 0,
          emptyBridgeSeen: 0,
          rustWorkerBridgeSeen: 0,
          imBridgeSeen: tracker.hasImBridge?.() ? 1 : 0,
        };
  report.homepageBridgeSeen = counts.homepageBridgeSeen;
  report.emptyBridgeSeen = counts.emptyBridgeSeen;
  report.rustWorkerBridgeSeen = counts.rustWorkerBridgeSeen;
  report.imBridgeSeen = Math.max(report.imBridgeSeen ? 1 : 0, counts.imBridgeSeen);
  return report;
}

function formatTs(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function buildWaitTextReport(report) {
  const lines = [];
  lines.push('=== 抖店等待真实买家消息验证报告 ===');
  lines.push(`时间: ${report.finishedAt || new Date().toISOString()}`);
  lines.push(`结果: ${report.success ? '成功' : '失败/等待结束'}`);
  lines.push(`reason: ${report.reason || ''}`);
  lines.push(`isMock: ${report.isMock || false}`);
  lines.push(`timeoutMinutes: ${report.timeoutMinutes}`);
  lines.push(`durationMs: ${report.durationMs}`);
  lines.push(`bridgeSuccess: ${report.bridgeSuccess}`);
  lines.push(`imBridgeSeen: ${report.imBridgeSeen}`);
  lines.push(`imOpenAttempted: ${report.imOpenAttempted}`);
  lines.push(`imOpenSuccess: ${report.imOpenSuccess}`);
  lines.push(`imWorkspaceWaitMs: ${report.imWorkspaceWaitMs}`);
  lines.push(`imWorkspaceReason: ${report.imWorkspaceReason || ''}`);
  lines.push(`homepageBridgeSeen: ${report.homepageBridgeSeen ?? 0}`);
  lines.push(`emptyBridgeSeen: ${report.emptyBridgeSeen ?? 0}`);
  lines.push(`rustWorkerBridgeSeen: ${report.rustWorkerBridgeSeen ?? 0}`);
  lines.push(`integrityWarningDetected: ${report.integrityWarningDetected ?? false}`);
  lines.push(`shopIdentitySuccess: ${report.shopIdentitySuccess}`);
  lines.push(`businessDataCaptured: ${report.businessDataCaptured}`);
  lines.push(
    `loggedInShopCount: ${report.loggedInShopCount ?? report.loggedInShops?.length ?? 0} activeImShopCount: ${report.activeImShopCount ?? report.activeImShops?.length ?? 0} inactiveShopCount: ${report.inactiveShopCount ?? report.inactiveShops?.length ?? 0}`
  );
  lines.push(`memoryCacheEventCount: ${report.memoryCacheEventCount}`);
  lines.push(`conversationListEventCount: ${report.conversationListEventCount}`);
  lines.push(`conversationEmptyEventCount: ${report.conversationEmptyEventCount}`);
  lines.push(`realMessageCandidateEventCount: ${report.realMessageCandidateEventCount}`);
  lines.push(`platformMessageInsertCount: ${report.platformMessageInsertCount}`);
  lines.push(`dedupeHitCount: ${report.dedupeHitCount}`);
  lines.push(`sqliteVerified: ${report.sqliteVerified}`);
  if (report.firstRealMessage) lines.push(`firstRealMessage: ${JSON.stringify(report.firstRealMessage)}`);
  if (report.warnings?.length) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  if (report.shopReportValid === false) {
    lines.push('');
    lines.push(`shopReportValid: false`);
    for (const e of report.shopReportErrors || []) lines.push(`- ${e}`);
  } else if (report.shopReportValid === true) {
    lines.push(`shopReportValid: true`);
  }
  if (report.nextActions?.length) {
    lines.push('');
    lines.push('Next actions:');
    for (const a of report.nextActions) lines.push(`- ${a}`);
  }
  return lines;
}

function parseTimeoutMinutes(argv = []) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--timeout-minutes' && argv[i + 1]) {
      return Math.max(1, Number(argv[i + 1]) || DEFAULT_TIMEOUT_MINUTES);
    }
  }
  return DEFAULT_TIMEOUT_MINUTES;
}

async function runWaitRealMessageSession(options = {}) {
  const cfg = getDoudianConfig();
  const knownShops = cfg.knownShops || [];
  const bridgePort = Number(options.bridgePort || cfg.bridgePort || 19527);
  const installDir = options.installDir || TEST_INSTALL_DIR;
  const exePath = path.join(installDir, 'doudian.exe');
  const timeoutMinutes = Number(options.timeoutMinutes || DEFAULT_TIMEOUT_MINUTES);
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const dbPath = options.dbPath || path.join(process.cwd(), 'logs', 'doudian-wait-real-message.db');
  const mockMode = Boolean(options.mockMode);

  const startedAt = Date.now();
  const report = {
    success: false,
    reason: '',
    isMock: mockMode,
    timeoutMinutes,
    durationMs: 0,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: '',
    bridgeSuccess: false,
    observerReady: false,
    shopIdentitySuccess: false,
    businessDataCaptured: false,
    loggedInShopCount: 0,
    activeImShopCount: 0,
    inactiveShopCount: 0,
    loggedInShops: [],
    activeImShops: [],
    inactiveShops: [],
    unknownBridges: [],
    unknownImBridges: [],
    imBridgeSeen: false,
    imOpenAttempted: false,
    imOpenAttempts: [],
    imOpenSuccess: false,
    imWorkspaceWaitMs: 0,
    imWorkspaceReason: '',
    unknownImBridgeCount: 0,
    homepageBridgeSeen: 0,
    emptyBridgeSeen: 0,
    rustWorkerBridgeSeen: 0,
    integrityWarningDetected: false,
    integrityWarnings: [],
    patchManifest: options.patchManifest || null,
    portGuard: options.portGuard || null,
    runLock: options.runLock || null,
    memoryCacheEventCount: 0,
    stdoutBusinessSignalCount: 0,
    conversationListEventCount: 0,
    conversationEmptyEventCount: 0,
    realMessageCandidateEventCount: 0,
    platformMessageInsertCount: 0,
    dedupeHitCount: 0,
    firstRealMessage: null,
    realMessageSamples: [],
    sqliteVerified: false,
    insertedMessageId: '',
    insertedRowId: 0,
    deduped: false,
    dedupeKey: '',
    warnings: [],
    errors: [],
    nextActions: [],
  };

  let resolveWait;
  let rejectWait;
  const completionPromise = new Promise((res, rej) => {
    resolveWait = res;
    rejectWait = rej;
  });

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  closeDb();
  process.env.DOUDIAN_VERIFY_DB = dbPath;

  const dedupe = new DoudianDedupe();
  const tracker = new ShopBridgeTracker({ knownShops });
  const shopIdentityHints = [];
  const memoryCacheHints = [];
  let stdoutLines = [];
  let lastBusinessEventAt = 0;
  let lastRealMessageAt = 0;
  let captured = false;

  function markBusinessEvent() {
    lastBusinessEventAt = Date.now();
    report.businessDataCaptured = true;
  }

  function printCaptureBanner(msg, meta = {}) {
    console.log('==============================');
    console.log('[抖店桥] 捕获真实买家消息');
    console.log(`shopId: ${msg.shopId || ''}`);
    console.log(`shopName: ${msg.shopName || ''}`);
    console.log(`conversationId: ${msg.conversationId ? `${String(msg.conversationId).slice(0, 8)}***` : ''}`);
    console.log(`buyerId: ${msg.buyerId ? `${String(msg.buyerId).slice(0, 4)}***` : ''}`);
    console.log(`buyerName: ${msg.buyerName || ''}`);
    console.log(`direction: ${msg.direction === 'outbound' ? 'seller' : 'buyer'}`);
    console.log(`messageType: ${msg.messageType || 'text'}`);
    console.log(`text: ${msg.text || ''}`);
    console.log(`source: ${meta.source || msg.source || ''}`);
    console.log(`inserted: ${meta.inserted !== false}`);
    console.log(`deduped: ${meta.deduped || false}`);
    console.log('==============================');
  }

  function tryCaptureRealMessage(item, shopInfo, meta = {}) {
    if (captured) return false;
    if (!isRealBuyerMessage(item, meta)) return false;

    const normalized = toNormalizedMessage(item, shopInfo, meta);
    const dedupeKey = dedupe.buildKey(normalized);
    const isDup = dedupe.isDuplicate(normalized);

    if (isDup) {
      report.dedupeHitCount += 1;
      report.deduped = true;
      report.dedupeKey = dedupeKey;
      printCaptureBanner(maskMessageForReport(normalized), { source: meta.source, inserted: false, deduped: true });
      finishSuccess(normalized, { deduped: true, dedupeKey });
      return true;
    }

    const insertResult = insertMessage(normalized);
    report.platformMessageInsertCount += 1;
    lastRealMessageAt = normalized.timestamp || Date.now();

    const row = getMessageById(insertResult.id) || getLastInsertedMessage();
    report.sqliteVerified = Boolean(row && row.text);
    report.insertedRowId = row?.id || insertResult.id || 0;
    report.insertedMessageId = row?.message_id || normalized.messageId || '';

    const masked = maskMessageForReport(normalized);
    if (!report.firstRealMessage) report.firstRealMessage = masked;
    if (report.realMessageSamples.length < 10) report.realMessageSamples.push(masked);

    printCaptureBanner(masked, { source: meta.source, inserted: true, deduped: false });
    finishSuccess(normalized, { deduped: false, dedupeKey, rowId: report.insertedRowId });
    return true;
  }

  function finishSuccess(normalized, extra = {}) {
    if (captured) return;
    captured = true;
    report.success = true;
    report.reason = mockMode ? 'mock_message_pipeline_ok' : 'real_message_captured';
    report.deduped = extra.deduped || false;
    report.dedupeKey = extra.dedupeKey || '';
    report.insertedRowId = extra.rowId || report.insertedRowId;
    resolveWait({ report, normalized });
  }

  const pipeline = new DoudianBusinessPipeline({
    dedupe,
    onRealBuyerMessage: (msg) => {
      tryCaptureRealMessage(
        { ...msg, direction: 'buyer', text: msg.text },
        { shopId: msg.shopId, shopName: msg.shopName },
        { source: 'memory_cache', bridgeId: msg.bridgeId }
      );
    },
  });

  function applyShopStats(stdoutSignal) {
    const snapshot = buildShopStatsSnapshot({
      tracker,
      stdoutSignal,
      knownShops,
      shopIdentityHints,
      memoryCacheHints,
    });
    applyShopStatsToTarget(report, snapshot);
    report.shopIdentitySuccess =
      report.shopIdentitySuccess ||
      snapshot.loggedInShopCount > 0 ||
      shopIdentityHints.some((h) => h.shopId);
  }

  let integrityWarnings = [];

  function handleEnvelope(envelope) {
    if (envelope.type === 'bridge.open_im_attempt') {
      attachOpenImAttemptResponse(report.imOpenAttempts, envelope);
    }

    const title = envelope.payload?.title || envelope.payload?.info?.title || '';
    integrityWarnings = scanWindowTitle(title, integrityWarnings);

    if (!LISTEN_WATCH_TYPES.has(envelope.type)) return;
    tracker.recordEvent(envelope);
    const p = envelope.payload || {};

    if (envelope.type === DOUDIAN_EVENTS.SHOP_IDENTITY_RESOLVED) {
      const shopInfo = p.shopInfo || p;
      shopIdentityHints.push({
        shopId: pickFirst(p.shopId, shopInfo.shopId),
        shopName: pickFirst(p.shopName, shopInfo.shopName),
        sessionPartitionKey: pickFirst(p.sessionPartitionKey, shopInfo.sessionPartitionKey),
        accountId: pickFirst(p.accountId, shopInfo.accountId),
        bridgeId: envelope.bridgeId,
        source: 'memory_cache',
      });
    }

    if (envelope.type === DOUDIAN_EVENTS.MEMORY_CACHE_CANDIDATE) {
      const shopInfo = p.shopInfo || {};
      memoryCacheHints.push({
        bridgeId: envelope.bridgeId,
        cacheKey: p.cacheKey || '',
        apiName: p.apiName || '',
        shopId: pickFirst(p.shopId, shopInfo.shopId),
        shopName: pickFirst(p.shopName, shopInfo.shopName),
        sessionPartitionKey: pickFirst(p.sessionPartitionKey, shopInfo.sessionPartitionKey),
        accountId: pickFirst(p.accountId, shopInfo.accountId),
        source: 'memory_cache',
      });
    }

    if (BUSINESS_PIPELINE_TYPES.has(envelope.type)) {
      pipeline.processEnvelope(envelope);
      const stats = pipeline.getStats();
      report.memoryCacheEventCount = stats.memoryCacheBusinessEventCount;
      report.conversationListEventCount = stats.conversationListEventCount;
      report.conversationEmptyEventCount = stats.conversationEmptyEventCount;
      report.realMessageCandidateEventCount = stats.realMessageCandidateEventCount;
      if (envelope.type === DOUDIAN_EVENTS.MEMORY_CACHE_CANDIDATE) {
        markBusinessEvent();
      }
    }

    if (envelope.type === DOUDIAN_EVENTS.MESSAGE_OBSERVER_READY) {
      report.observerReady = true;
    }

    if (envelope.type === DOUDIAN_EVENTS.CONVERSATION_LIST) {
      markBusinessEvent();
      const shopInfo = p.shopInfo || {};
      const conversations = Array.isArray(p.conversations) ? p.conversations : [];
      for (const conv of conversations) {
        tryCaptureRealMessage(conv, shopInfo, {
          source: 'memory_cache',
          apiName: 'get_current_conversation_list',
          bridgeId: envelope.bridgeId,
        });
      }
    }

    if (envelope.type === DOUDIAN_EVENTS.MESSAGE_REAL_CANDIDATE) {
      markBusinessEvent();
      const shopInfo = p.shopInfo || {};
      const items = Array.isArray(p.items) ? p.items : [];
      for (const item of items) {
        tryCaptureRealMessage(item, shopInfo, {
          source: p.source || 'memory_cache',
          apiName: p.apiName || '',
          bridgeId: envelope.bridgeId,
        });
      }
    }

    if (envelope.type === DOUDIAN_EVENTS.MESSAGE_DOM_CANDIDATE) {
      tryCaptureRealMessage(
        {
          text: p.text,
          conversationId: p.conversationId,
          buyerId: p.buyerId,
          messageId: p.messageId,
          buyerName: p.buyerName,
        },
        { shopId: p.shopId, shopName: p.shopName },
        {
          source: 'dom',
          selectorHint: p.selectorHint || '',
          bridgeId: envelope.bridgeId,
          pageHref: p.pageHref,
        }
      );
    }

    if (envelope.type === DOUDIAN_EVENTS.MESSAGE_NETWORK_CANDIDATE) {
      const apiName = resolveApiName(p.urlPath || p.url || '');
      tryCaptureRealMessage(
        {
          text: p.text || p.textSample,
          conversationId: p.shopHints?.conversationId,
          buyerId: p.shopHints?.buyerId,
          messageId: p.messageId,
        },
        { shopId: p.shopId, shopName: p.shopName },
        { source: 'ipc', apiName, bridgeId: envelope.bridgeId }
      );
    }
  }

  if (mockMode) {
    const mockItem = options.mockMessage || {
      conversationId: 'conv_mock_wait_001',
      buyerId: 'buyer_***88',
      buyerName: '测试买家',
      messageId: 'msg_mock_wait_001',
      text: '你好，这是一条脱敏模拟买家消息',
      direction: 'buyer',
      messageType: 'text',
      timestamp: Date.now(),
    };
    const shopInfo = options.mockShopInfo || {
      shopId: '263636465',
      shopName: 'XY祥钰珠宝',
    };
    tryCaptureRealMessage(mockItem, shopInfo, { source: 'mock', apiName: 'mock' });
    shopIdentityHints.push({
      shopId: shopInfo.shopId,
      shopName: shopInfo.shopName,
      source: 'memory_cache',
    });
    const mockStdout = parseStdoutBusinessSignals([
      `init window with accounts shopId=${shopInfo.shopId} shopName=${shopInfo.shopName}`,
      'init window with accounts shopId=276595872 shopName=梵诗娅珠宝',
    ]);
    applyShopStats(mockStdout);
    report.durationMs = Date.now() - startedAt;
    report.finishedAt = new Date().toISOString();
    return report;
  }

  if (!fs.existsSync(exePath)) {
    report.errors.push(`doudian.exe 不存在: ${exePath}`);
    report.reason = 'doudian_exe_missing';
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return report;
  }

  const wsServer = getDoudianWsServer({ port: bridgePort });
  const { startBridgeWsServer } = require('./auto-verify-utils');
  const wsStarted = await startBridgeWsServer(wsServer, report);
  if (!wsStarted) {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return report;
  }
  wsServer.on('*', handleEnvelope);

  stdoutLines = [];
  const observersSent = new Set();
  const shopInfoSent = new Set();
  let lastObserverAttemptAt = 0;
  let lastBriefingAt = 0;

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
      if (redacted) {
        stdoutLines.push(redacted);
        integrityWarnings = scanStdoutLine(redacted, integrityWarnings);
      }
    }
  };
  child.stdout.on('data', onStdoutChunk);
  child.stderr.on('data', onStdoutChunk);

  console.log(`[抖店桥] 等待真实买家消息模式已启动，超时 ${timeoutMinutes} 分钟`);

  await sleep(3000);

  const imResult = await runDoudianImWorkspacePhase({
    wsServer,
    bridgeTracker: tracker,
    report,
    timeoutMs: DEFAULT_IM_WAIT_MS,
    openIfMissing: true,
    onTick: () => {
      const stdoutSignal = parseStdoutBusinessSignals(stdoutLines);
      applyShopStats(stdoutSignal);
      applyBridgeClassificationToReport(report, tracker);
      applyIntegrityWarningsToReport(report, integrityWarnings);
    },
    logPrefix: '[抖店桥]',
  });

  report.bridgeSuccess = imResult.imBridgeSeen === 1;
  applyBridgeClassificationToReport(report, tracker);
  applyIntegrityWarningsToReport(report, integrityWarnings);

  if (imResult.imBridgeSeen !== 1) {
    report.success = false;
    report.reason = 'im_workspace_not_opened';
    report.durationMs = Date.now() - startedAt;
    report.finishedAt = new Date().toISOString();
    applyShopStats(parseStdoutBusinessSignals(stdoutLines));
    report.unknownImBridgeCount = report.unknownImBridges?.length || 0;
    report.warnings.push('IM workspace 未在时限内打开，未进入真实消息等待阶段');
    report.nextActions = [
      '确认 patch 已应用到测试目录并重启抖店',
      '运行 npm run doudian:auto-verify-im 单独验证 IM bridge',
      '检查 debug.open_im_workspace 是否收到 bridge.open_im_attempt 回执',
    ];
    try {
      child.unref();
    } catch {
      // ignore
    }
    return report;
  }

  console.log('[抖店桥] 阶段2: IM workspace 已就绪，开始等待真实买家消息...');
  const messageWaitStarted = Date.now();
  const messageTimeoutMs = timeoutMinutes * 60 * 1000;

  const waitLoop = async () => {
    while (!captured && Date.now() - messageWaitStarted < messageTimeoutMs) {
      report.bridgeSuccess = tracker.hasImBridge();
      report.imBridgeSeen = report.bridgeSuccess ? 1 : 0;
      applyBridgeClassificationToReport(report, tracker);
      applyIntegrityWarningsToReport(report, integrityWarnings);
      report.observerReady = report.observerReady || tracker.getAllBridges().some((b) => b.observerReady);
      tracker.refreshShopStats();
      const stdoutSignal = parseStdoutBusinessSignals(stdoutLines);
      report.stdoutBusinessSignalCount = stdoutSignal.apiSignals.length + stdoutSignal.shopIds.length;
      applyShopStats(stdoutSignal);
      report.unknownImBridgeCount = report.unknownImBridges?.length || 0;

      if (stdoutSignal.apiSignals.length > 0) markBusinessEvent();

      const imBridgeIds = tracker.getImBridgeIds();
      for (const id of imBridgeIds) {
        if (!shopInfoSent.has(id)) {
          wsServer.sendDebugCommand(id, 'debug.get_shop_info', {});
          shopInfoSent.add(id);
        }
      }

      if (report.bridgeSuccess && Date.now() - lastObserverAttemptAt > 10000) {
        for (const id of imBridgeIds) {
          if (observersSent.has(id)) continue;
          wsServer.sendDebugCommand(id, 'debug.start_message_observer', {});
          observersSent.add(id);
        }
        lastObserverAttemptAt = Date.now();
      }

      const stats = pipeline.getStats();
      report.memoryCacheEventCount = stats.memoryCacheBusinessEventCount;
      report.conversationListEventCount = stats.conversationListEventCount;
      report.conversationEmptyEventCount = stats.conversationEmptyEventCount;
      report.realMessageCandidateEventCount = stats.realMessageCandidateEventCount;

      if (Date.now() - lastBriefingAt >= BRIEFING_MS) {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        console.log('[抖店桥] live summary:');
        console.log(`运行时长: ${elapsed}秒`);
        console.log(`loggedInShopCount: ${report.loggedInShopCount}`);
        console.log(`activeImShopCount: ${report.activeImShopCount}`);
        console.log(`imBridgeSeen: ${report.imBridgeSeen}`);
        console.log(`memoryCacheEvents: ${report.memoryCacheEventCount}`);
        console.log(`conversationListEvents: ${report.conversationListEventCount}`);
        console.log(`conversationEmptyEvents: ${report.conversationEmptyEventCount}`);
        console.log(`realMessageCandidateEvents: ${report.realMessageCandidateEventCount}`);
        console.log(`platformMessageInsertCount: ${report.platformMessageInsertCount}`);
        console.log(`lastBusinessEventAt: ${formatTs(lastBusinessEventAt)}`);
        console.log(`lastRealMessageAt: ${lastRealMessageAt ? formatTs(lastRealMessageAt) : '-'}`);
        console.log('状态: 等待真实买家消息中');
        lastBriefingAt = Date.now();
      }

      await sleep(1000);
    }

    if (!captured) {
      report.success = false;
      report.reason = 'wait_timeout_no_real_message';
      resolveWait({ report });
    }
  };

  waitLoop();
  const result = await completionPromise;

  report.durationMs = Date.now() - startedAt;
  report.finishedAt = new Date().toISOString();

  applyShopStats(parseStdoutBusinessSignals(stdoutLines));
  report.imBridgeSeen = report.imBridgeSeen || (tracker.hasImBridge() ? 1 : 0);
  applyBridgeClassificationToReport(report, tracker);
  applyIntegrityWarningsToReport(report, integrityWarnings);
  report.unknownImBridgeCount = report.unknownImBridges?.length || 0;

  if (report.loggedInShopCount >= 2 && report.activeImShopCount < report.loggedInShopCount && report.imBridgeSeen) {
    report.warnings.push(
      `已登录 ${report.loggedInShopCount} 个店铺，当前 IM 仅激活 ${report.activeImShopCount} 个`
    );
    for (const inactive of report.inactiveShops || []) {
      const ks = knownShops.find((k) => k.shopId === inactive.shopId);
      if (ks) {
        report.warnings.push(
          `检测到第二店铺「${ks.shopName}」已登录但未激活 IM 页；需手动切换后再验证真实消息`
        );
      }
    }
  }

  if (report.success) {
    report.nextActions = [
      '真实买家消息链路已验证，可继续精修 parser 字段',
      '如需多店铺，手动切换后再次运行 wait-real-message',
    ];
  } else if (report.reason === 'wait_timeout_no_real_message') {
    report.nextActions = [
      'IM workspace 已打开，当前时段无真实买家消息，可延长 --timeout-minutes 或手动打开有咨询的会话',
      '可用 doudian:wait-real-message:test-mock 验证入库链路',
    ];
  } else if (report.reason === 'im_workspace_not_opened') {
    report.nextActions = [
      'IM workspace 未能自动打开，运行 npm run doudian:auto-verify-im 排查',
      '确认首页 bridge 已连通且 debug.open_im_workspace 有回执',
    ];
  } else {
    report.nextActions = [
      '当前时段无真实买家消息，可延长 --timeout-minutes 或手动打开有咨询的会话',
      '可用 doudian:wait-real-message:test-mock 验证入库链路',
    ];
  }

  try {
    child.unref();
  } catch {
    // ignore
  }

  return result.report || report;
}

module.exports = {
  runWaitRealMessageSession,
  parseTimeoutMinutes,
  buildWaitTextReport,
  DEFAULT_TIMEOUT_MINUTES,
  BRIEFING_MS,
};
