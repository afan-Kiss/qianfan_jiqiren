const path = require('path');
const fs = require('fs');
const { getDoudianConfig } = require('../../shared/config');
const { DOUDIAN_EVENTS } = require('./doudian-types');
const { closeDb } = require('./doudian-data-store');
const { pickFirst } = require('./doudian-shop-utils');
const {
  createImLiveContext,
  bootstrapImLiveClient,
  sanitizeLiveReport,
  sleep,
} = require('./doudian-im-live-shared');
const { applyIntegrityWarningsToReport } = require('./doudian-integrity-warning-monitor');
const {
  GUIDED_POLL_MS,
  GUIDED_BRIEFING_MS,
  GUIDED_DEFAULT_TIMEOUT_MINUTES,
  isGuidedConversationReady,
  printGuidedConversationBriefing,
} = require('./doudian-conversation-guided-shared');
const {
  applyMergedSourcesToReport,
  applyEmptyStateFlags,
} = require('./doudian-conversation-sources-resolver');
const { analyzeDomInspection, bubblesToHistoryItems } = require('./doudian-chat-dom-trust');

const SEND_URL_RE = /send|message|pigeon|backstage|im/i;
const MANUAL_SEND_GRACE_MS = 20000;

function parseObserveManualSendCliArgs(argv = []) {
  let timeoutMinutes = GUIDED_DEFAULT_TIMEOUT_MINUTES;
  let noRestart = false;
  let exitOnDetect = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--timeout-minutes' && argv[i + 1]) {
      timeoutMinutes = Math.max(1, Number(argv[++i]) || GUIDED_DEFAULT_TIMEOUT_MINUTES);
    } else if (argv[i] === '--no-restart') noRestart = true;
    else if (argv[i] === '--exit-on-detect') exitOnDetect = true;
  }
  return { timeoutMinutes, noRestart, exitOnDetect };
}

function buildObserveManualSendTextReport(report) {
  const lines = [];
  lines.push('=== 抖店手动发送抓包诊断报告 ===');
  lines.push(`时间: ${report.finishedAt || new Date().toISOString()}`);
  lines.push(`结果: ${report.success ? '成功' : '失败/未完成'}`);
  lines.push(`reason: ${report.reason || ''}`);
  lines.push(`buyerName: ${report.buyerName || ''}`);
  lines.push(`buyerId: ${report.buyerId || ''}`);
  lines.push(`observerReady: ${report.observerReady || false}`);
  lines.push(`networkCaptureCount: ${report.networkCaptureCount || 0}`);
  lines.push(`domSellerBubbleCount: ${report.domSellerBubbleCount || 0}`);
  lines.push(`manualSendDetected: ${report.manualSendDetected || false}`);
  if (report.manualSendText) lines.push(`manualSendText: ${report.manualSendText}`);
  if (report.sendApiSamples?.length) {
    lines.push('sendApiSamples:');
    for (const s of report.sendApiSamples.slice(0, 10)) {
      lines.push(`- ${s.url} | ${s.text || ''}`);
    }
  }
  if (report.sellerBubbleSamples?.length) {
    lines.push('sellerBubbleSamples:');
    for (const s of report.sellerBubbleSamples.slice(0, 10)) {
      lines.push(`- ${s.text || ''}`);
    }
  }
  return lines;
}

async function runObserveManualSendGuidedSession(options = {}) {
  const cfg = getDoudianConfig();
  const knownShops = cfg.knownShops || [];
  const bridgePort = Number(options.bridgePort || cfg.bridgePort || 19527);
  const installDir = options.installDir;
  const timeoutMinutes = Number(options.timeoutMinutes || GUIDED_DEFAULT_TIMEOUT_MINUTES);
  const startedAt = Date.now();

  const report = {
    success: false,
    reason: '',
    guidedMode: true,
    timeoutMinutes,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: '',
    durationMs: 0,
    imBridgeSeen: 0,
    activeShopResolved: false,
    shopId: '',
    shopName: '',
    buyerId: '',
    buyerName: '',
    selectedConversationDetected: false,
    observerReady: false,
    baselineSellerTexts: [],
    networkCaptureCount: 0,
    networkSamples: [],
    sendApiSamples: [],
    domSellerBubbleCount: 0,
    sellerBubbleSamples: [],
    manualSendDetected: false,
    manualSendText: '',
    patchManifest: options.patchManifest || null,
    portGuard: options.portGuard || null,
    runLock: options.runLock || null,
    warnings: [],
    errors: [],
    nextActions: [],
  };

  const dbPath =
    options.dbPath || path.join(process.cwd(), 'logs', 'doudian-observe-manual-send-guided.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  closeDb();
  process.env.DOUDIAN_VERIFY_DB = dbPath;

  const ctx = createImLiveContext({ knownShops, report });
  let observerStarted = false;
  let baselineCaptured = false;
  let lastPollAt = 0;
  let lastBriefingAt = 0;
  let baselineGraceUntil = 0;
  const exitOnDetect = Boolean(options.exitOnDetect);
  const keepClientAlive = options.keepClientAlive !== false;

  function normalizeBubbleText(text = '') {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function recordNetwork(envelope, p) {
    const url = pickFirst(p.urlPath, p.url, p.cacheKey, envelope.payload?.urlPath);
    const text = pickFirst(p.text, p.textSample, p.content);
    report.networkCaptureCount += 1;
    const row = { url: String(url || '').slice(0, 200), text: String(text || '').slice(0, 120), at: Date.now() };
    report.networkSamples.push(row);
    if (report.networkSamples.length > 80) report.networkSamples.shift();
    if (SEND_URL_RE.test(row.url) || /发送|message|send/i.test(row.text)) {
      report.sendApiSamples.push(row);
      if (report.sendApiSamples.length > 20) report.sendApiSamples.shift();
    }
  }

  function captureSellerBubblesFromDom(payload = {}) {
    const analysis = analyzeDomInspection(payload);
    const items = bubblesToHistoryItems(analysis.trustedBubbles || []);
    return items.filter((m) => String(m.direction || '').toLowerCase() === 'seller');
  }

  function checkManualSend(sellerBubbles = []) {
    if (Date.now() < baselineGraceUntil) return false;
    const baseline = new Set(
      report.baselineSellerTexts.map((t) => normalizeBubbleText(t)).filter(Boolean)
    );
    for (const b of sellerBubbles) {
      const text = normalizeBubbleText(b.text);
      if (!text || text.length < 2 || baseline.has(text)) continue;
      if (baseline.size && [...baseline].some((old) => old.includes(text) || text.includes(old))) continue;
      report.manualSendDetected = true;
      report.manualSendText = text.slice(0, 200);
      report.domSellerBubbleCount = sellerBubbles.length;
      report.sellerBubbleSamples = sellerBubbles
        .slice(-10)
        .map((m) => ({ text: normalizeBubbleText(m.text).slice(0, 120) }));
      report.success = true;
      report.reason = 'manual_send_detected_in_chat';
      console.log(`[抖店桥] 检测到新商家消息: ${report.manualSendText}`);
      return exitOnDetect;
    }
    return false;
  }

  ctx.handlers.push((envelope, p) => {
    if (envelope.type === DOUDIAN_EVENTS.MESSAGE_OBSERVER_READY) {
      report.observerReady = true;
    }
    if (
      envelope.type === DOUDIAN_EVENTS.CONVERSATION_SOURCES_INSPECTION ||
      envelope.type === DOUDIAN_EVENTS.CONVERSATION_LIST_CAPTURED
    ) {
      applyMergedSourcesToReport(report, p);
      applyEmptyStateFlags(report);
    }
    if (
      envelope.type === DOUDIAN_EVENTS.MESSAGE_NETWORK_CANDIDATE ||
      envelope.type === DOUDIAN_EVENTS.WORKER_NETWORK_CANDIDATE ||
      envelope.type === DOUDIAN_EVENTS.MESSAGE_REAL_CANDIDATE
    ) {
      recordNetwork(envelope, p);
    }
    if (envelope.type === DOUDIAN_EVENTS.NETWORK_BUFFER_REPLAY) {
      const items = Array.isArray(p.items) ? p.items : [];
      for (const item of items) {
        recordNetwork(envelope, item);
      }
    }
    if (envelope.type === DOUDIAN_EVENTS.CHAT_DOM_INSPECTION) {
      const sellers = captureSellerBubblesFromDom(p);
      if (!baselineCaptured && isGuidedConversationReady(report)) {
        report.baselineSellerTexts = sellers.map((m) => m.text);
        baselineCaptured = true;
        baselineGraceUntil = Date.now() + MANUAL_SEND_GRACE_MS;
        console.log('\n[抖店桥] 基线聊天区已记录');
        console.log(`[抖店桥] 请 ${MANUAL_SEND_GRACE_MS / 1000} 秒后在输入框手动发送测试消息（例如：测试发送123），并点击发送按钮`);
        console.log('[抖店桥] 抖店窗口会保持打开直到超时，不会提前关闭');
      } else if (baselineCaptured && checkManualSend(sellers) && exitOnDetect) {
        report.__exitRequested = true;
      }
    }
    if (envelope.type === DOUDIAN_EVENTS.MESSAGE_OUTBOUND || envelope.type === DOUDIAN_EVENTS.MESSAGE_DOM_ADDED) {
      if (Date.now() < baselineGraceUntil) return;
      const text = pickFirst(p.text, p.messageText, p.content);
      if (text) {
        report.manualSendDetected = true;
        report.manualSendText = String(text).slice(0, 200);
        report.success = true;
        report.reason = 'manual_send_outbound_event';
        console.log(`[抖店桥] 检测到 outbound 事件: ${report.manualSendText}`);
        if (exitOnDetect) report.__exitRequested = true;
      }
    }
  });

  const boot = await bootstrapImLiveClient({
    installDir,
    bridgePort,
    report,
    ctx,
    logLabel: 'observe-manual-send-guided',
    timeoutMinutes,
    keepClientAlive,
  });

  if (!boot.ok) {
    report.reason = boot.reason || 'im_workspace_not_opened';
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeLiveReport(report);
  }

  const { wsServer, child } = boot;
  report.imBridgeSeen = 1;
  console.log('[抖店桥] 请先手动点开目标买家会话，识别后我会记录基线并等待您手动发送');

  const timeoutMs = timeoutMinutes * 60 * 1000;
  const waitStarted = Date.now();

  while (Date.now() - waitStarted < timeoutMs) {
    if (report.__exitRequested && exitOnDetect) break;
    ctx.applyShopStats();
    applyIntegrityWarningsToReport(report, ctx.integrityWarnings);
    ctx.tracker.refreshShopStats();
    report.imBridgeSeen = Math.max(report.imBridgeSeen || 0, ctx.tracker.hasImBridge() ? 1 : 0);
    report.activeShopResolved = Boolean(report.shopId || report.activeShop?.shopId);

    const imBridgeIds = ctx.tracker.getImBridgeIds();
    ctx.refreshConversationSelectionFromHints();
    report.selectedConversationDetected = isGuidedConversationReady(report);

    if (!observerStarted && report.selectedConversationDetected) {
      for (const id of imBridgeIds) {
        wsServer.sendDebugCommand(id, 'debug.start_message_observer', {});
      }
      observerStarted = true;
    }

    if (Date.now() - lastPollAt >= GUIDED_POLL_MS) {
      for (const id of imBridgeIds) {
        wsServer.sendDebugCommand(id, 'debug.inspect_conversation_sources', {});
        wsServer.sendDebugCommand(id, 'debug.inspect_chat_dom', {});
      }
      lastPollAt = Date.now();
    }

    if (Date.now() - lastBriefingAt >= GUIDED_BRIEFING_MS) {
      if (!report.selectedConversationDetected) {
        printGuidedConversationBriefing(report, 'observe manual send');
      } else if (!baselineCaptured) {
        console.log('[抖店桥] 已识别会话，正在记录聊天基线...');
      } else if (Date.now() < baselineGraceUntil) {
        const left = Math.ceil((baselineGraceUntil - Date.now()) / 1000);
        console.log(`[抖店桥] 准备中，${left}s 后可开始手动发送...`);
      } else {
        console.log(
          `[抖店桥] 等待手动发送... network=${report.networkCaptureCount} sendApi=${report.sendApiSamples.length} detected=${report.manualSendDetected}`
        );
      }
      lastBriefingAt = Date.now();
    }

    await sleep(1000);
  }

  if (!report.success) {
    report.reason = report.selectedConversationDetected
      ? baselineCaptured
        ? 'timeout_no_manual_send_detected'
        : 'timeout_no_baseline'
      : 'timeout_no_selected_conversation';
    report.nextActions = [
      '确认已在 IM 点选买家并在输入框手动点击发送',
      '重新运行: npm run doudian:observe-manual-send-guided -- --timeout-minutes 15',
    ];
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  if (keepClientAlive) {
    console.log('[抖店桥] 脚本结束，抖店客户端保持打开（未杀进程）');
  }
  try {
    if (child && !keepClientAlive) child.unref();
  } catch {
    // ignore
  }
  return sanitizeLiveReport(report);
}

module.exports = {
  runObserveManualSendGuidedSession,
  parseObserveManualSendCliArgs,
  buildObserveManualSendTextReport,
};
