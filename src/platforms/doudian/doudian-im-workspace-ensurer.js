const DEFAULT_IM_WAIT_MS = 180000;
const FIRST_IM_OPEN_DELAY_MS = 30000;
const RETRY_OPEN_INTERVAL_MS = 15000;
const NO_HOMEPAGE_MAX_WAIT_MS = 120000;
const HOMEPAGE_STALE_GRACE_MS = 180000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attachOpenImAttemptResponse(attempts, envelope) {
  if (!Array.isArray(attempts) || !envelope) return false;
  const p = envelope.payload || {};
  const bridgeId = envelope.bridgeId || '';
  const response = {
    bridgeId,
    method: p.method || '',
    ok: Boolean(p.ok),
    href: p.href || '',
    error: p.error || '',
    reason: p.reason || '',
    at: envelope.timestamp || Date.now(),
  };

  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    const attempt = attempts[i];
    if (!attempt.targetBridgeIds?.includes(bridgeId)) continue;
    attempt.responses = attempt.responses || [];
    attempt.responses.push(response);
    return true;
  }

  attempts.push({
    at: Date.now(),
    reason: 'response_without_command',
    targetBridgeIds: bridgeId ? [bridgeId] : [],
    sent: [],
    responses: [response],
  });
  return true;
}

function hasRecentHomepageInTracker(tracker, maxAgeMs = HOMEPAGE_STALE_GRACE_MS) {
  if (!tracker || typeof tracker.getAllBridges !== 'function') return false;
  const now = Date.now();
  return tracker.getAllBridges().some((b) => {
    if (!b.isHomepage && !b.isEmptyBridge) return false;
    return now - (b.lastSeenAt || 0) < maxAgeMs;
  });
}

function resolveOpenCommandTargetBridgeIds(tracker, wsServer) {
  const ordered = [];
  const seen = new Set();

  function add(id) {
    const key = String(id || '').trim();
    if (!key || seen.has(key)) return;
    if (wsServer && typeof wsServer.isBridgeConnected === 'function' && !wsServer.isBridgeConnected(key)) {
      return;
    }
    seen.add(key);
    ordered.push(key);
  }

  if (wsServer && typeof wsServer.getLiveOpenCommandTargets === 'function') {
    for (const id of wsServer.getLiveOpenCommandTargets()) add(id);
  }

  if (tracker && typeof tracker.getHomepageBridgeIds === 'function') {
    for (const id of tracker.getHomepageBridgeIds()) add(id);
  }
  if (tracker && typeof tracker.getEmptyBridgeIds === 'function') {
    for (const id of tracker.getEmptyBridgeIds()) add(id);
  }

  if (ordered.length === 0 && wsServer && typeof wsServer.getBridgeIds === 'function') {
    for (const id of wsServer.getBridgeIds()) {
      const state = wsServer.getBridgeState?.(id);
      if (state && wsServer.isOpenCommandBridgeUrl?.(state.pageUrl)) {
        add(id);
      }
    }
  }

  if (tracker && typeof tracker.getRecentOpenCommandBridgeIds === 'function') {
    for (const id of tracker.getRecentOpenCommandBridgeIds(HOMEPAGE_STALE_GRACE_MS)) add(id);
  }

  return ordered;
}

function applyImOpenResultToReport(report, imResult, tracker) {
  if (!report || !imResult) return report;
  report.imBridgeSeen = imResult.imBridgeSeen;
  report.imOpenAttempted = imResult.imOpenAttempted;
  report.imOpenAttempts = imResult.imOpenAttempts || report.imOpenAttempts || [];
  report.imOpenSuccess = imResult.imOpenSuccess;
  report.imWorkspaceWaitMs = imResult.imWorkspaceWaitMs;
  report.imWorkspaceReason = imResult.reason || '';

  if (tracker && typeof tracker.getBridgeClassificationCounts === 'function') {
    const counts = tracker.getBridgeClassificationCounts();
    report.homepageBridgeSeen = counts.homepageBridgeSeen;
    report.emptyBridgeSeen = counts.emptyBridgeSeen;
    report.rustWorkerBridgeSeen = counts.rustWorkerBridgeSeen;
    report.imBridgeSeen = Math.max(report.imBridgeSeen || 0, counts.imBridgeSeen);
  }
  return report;
}

async function waitForImWorkspace(options = {}) {
  const {
    tracker,
    wsServer,
    startedAt = Date.now(),
    maxWaitMs = DEFAULT_IM_WAIT_MS,
    firstOpenDelayMs = FIRST_IM_OPEN_DELAY_MS,
    retryOpenIntervalMs = RETRY_OPEN_INTERVAL_MS,
    noHomepageMaxWaitMs = NO_HOMEPAGE_MAX_WAIT_MS,
    openIfMissing = true,
    onOpenAttempt,
    onTick,
  } = options;

  if (!tracker || !wsServer) {
    throw new Error('waitForImWorkspace requires tracker and wsServer');
  }

  const result = {
    imBridgeSuccess: false,
    imOpenAttempted: false,
    imOpenAttempts: [],
    imOpenSuccess: false,
    imWorkspaceWaitMs: 0,
    imWorkspaceReason: '',
    homepageBridgeSuccess: false,
    firstImBridge: null,
  };

  let lastImOpenAttemptAt = 0;
  let homepageEverSeen = false;

  function hasImBridge() {
    return typeof tracker.hasImBridge === 'function' && tracker.hasImBridge();
  }

  function hasHomepageBridge() {
    if (typeof tracker.hasHomepageBridge === 'function' && tracker.hasHomepageBridge()) return true;
    if (typeof wsServer.hasLiveOpenCommandTarget === 'function' && wsServer.hasLiveOpenCommandTarget()) {
      return true;
    }
    return hasRecentHomepageInTracker(tracker, HOMEPAGE_STALE_GRACE_MS);
  }

  function pickFirstImBridgeEvent() {
    if (typeof tracker.getFirstImBridgeEvent === 'function') {
      return tracker.getFirstImBridgeEvent();
    }
    for (const e of tracker.events || []) {
      if (e.isImWorkspace) return e;
    }
    return null;
  }

  async function tryOpenImViaCommand(reason) {
    if (!openIfMissing) return false;
    const ids = resolveOpenCommandTargetBridgeIds(tracker, wsServer);
    if (!ids.length) return false;

    result.imOpenAttempted = true;
    const attempt = {
      at: Date.now(),
      reason,
      targetBridgeIds: [...ids],
      sent: [],
      responses: [],
    };

    for (const id of ids) {
      const ok = wsServer.sendDebugCommand(id, 'debug.open_im_workspace', { source: reason });
      attempt.sent.push({ bridgeId: id, ok: Boolean(ok) });
      console.log(`[im-open] debug.open_im_workspace -> ${id} ok=${Boolean(ok)} (${reason})`);
    }

    result.imOpenAttempts.push(attempt);
    lastImOpenAttemptAt = Date.now();
    if (onOpenAttempt) onOpenAttempt(attempt);
    return attempt.sent.some((s) => s.ok);
  }

  while (Date.now() - startedAt < maxWaitMs) {
    result.homepageBridgeSuccess = hasHomepageBridge();
    if (result.homepageBridgeSuccess) homepageEverSeen = true;

    if (hasImBridge()) {
      result.imBridgeSuccess = true;
      result.imOpenSuccess = true;
      result.imWorkspaceReason = 'im_bridge_seen';
      result.firstImBridge = pickFirstImBridgeEvent();
      break;
    }

    const elapsed = Date.now() - startedAt;
    const liveTargets = resolveOpenCommandTargetBridgeIds(tracker, wsServer);

    if (
      !result.homepageBridgeSuccess &&
      !homepageEverSeen &&
      liveTargets.length === 0 &&
      elapsed >= noHomepageMaxWaitMs
    ) {
      result.imWorkspaceReason = 'homepage_bridge_not_seen';
      break;
    }

    if (openIfMissing && (result.homepageBridgeSuccess || homepageEverSeen || liveTargets.length > 0 || result.imOpenAttempted)) {
      if (elapsed >= firstOpenDelayMs && Date.now() - lastImOpenAttemptAt >= retryOpenIntervalMs) {
        const targets = resolveOpenCommandTargetBridgeIds(tracker, wsServer);
        if (targets.length > 0) {
          let reason = 'scheduled';
          if (result.imOpenAttempts.length === 0) reason = 'first_homepage_seen_30s';
          else reason = `retry_${result.imOpenAttempts.length}`;
          await tryOpenImViaCommand(reason);
        } else if (!result.imOpenAttempted && (result.homepageBridgeSuccess || homepageEverSeen)) {
          await tryOpenImViaCommand('first_homepage_seen_30s');
        }
      }
    }

    if (onTick) onTick(elapsed);
    await sleep(2000);
  }

  result.imWorkspaceWaitMs = Date.now() - startedAt;
  result.homepageBridgeSuccess = hasHomepageBridge() || homepageEverSeen;

  if (!result.imBridgeSuccess) {
    if (!result.imWorkspaceReason) {
      if (!result.homepageBridgeSuccess && !homepageEverSeen) {
        result.imWorkspaceReason = 'homepage_bridge_not_seen';
      } else if (!result.imOpenAttempted) {
        result.imWorkspaceReason = openIfMissing ? 'im_not_opened_before_timeout' : 'im_bridge_not_seen';
      } else {
        result.imWorkspaceReason = 'im_open_attempted_but_no_bridge';
      }
    }
  } else if (!result.firstImBridge) {
    result.firstImBridge = pickFirstImBridgeEvent();
  }

  return result;
}

async function ensureDoudianImWorkspaceOpen(options = {}) {
  const {
    wsServer,
    bridgeTracker,
    timeoutMs = DEFAULT_IM_WAIT_MS,
    firstOpenDelayMs = FIRST_IM_OPEN_DELAY_MS,
    retryOpenIntervalMs = RETRY_OPEN_INTERVAL_MS,
    noHomepageMaxWaitMs = NO_HOMEPAGE_MAX_WAIT_MS,
    openIfMissing = true,
    onOpenAttempt,
    onTick,
  } = options;

  const startedAt = Date.now();
  const internal = await waitForImWorkspace({
    tracker: bridgeTracker,
    wsServer,
    startedAt,
    maxWaitMs: timeoutMs,
    firstOpenDelayMs,
    retryOpenIntervalMs,
    noHomepageMaxWaitMs,
    openIfMissing,
    onOpenAttempt,
    onTick,
  });

  return {
    imBridgeSeen: internal.imBridgeSuccess ? 1 : 0,
    imOpenAttempted: internal.imOpenAttempted,
    imOpenSuccess: internal.imOpenSuccess,
    imOpenAttempts: internal.imOpenAttempts,
    imWorkspaceWaitMs: internal.imWorkspaceWaitMs,
    reason: internal.imWorkspaceReason,
    homepageBridgeSuccess: internal.homepageBridgeSuccess,
    firstImBridge: internal.firstImBridge,
  };
}

async function runDoudianImWorkspacePhase(options = {}) {
  const {
    wsServer,
    bridgeTracker,
    report,
    timeoutMs = DEFAULT_IM_WAIT_MS,
    openIfMissing = true,
    onOpenAttempt,
    onTick,
    logPrefix = '[抖店桥]',
  } = options;

  console.log(`${logPrefix} 阶段1: 等待 IM workspace bridge（最长 ${timeoutMs / 1000}s）...`);

  const imResult = await ensureDoudianImWorkspaceOpen({
    wsServer,
    bridgeTracker,
    timeoutMs,
    openIfMissing,
    onOpenAttempt,
    onTick,
  });

  if (report) applyImOpenResultToReport(report, imResult, bridgeTracker);
  return imResult;
}

module.exports = {
  ensureDoudianImWorkspaceOpen,
  waitForImWorkspace,
  attachOpenImAttemptResponse,
  applyImOpenResultToReport,
  runDoudianImWorkspacePhase,
  resolveOpenCommandTargetBridgeIds,
  hasRecentHomepageInTracker,
  DEFAULT_IM_WAIT_MS,
  FIRST_IM_OPEN_DELAY_MS,
  RETRY_OPEN_INTERVAL_MS,
  NO_HOMEPAGE_MAX_WAIT_MS,
  HOMEPAGE_STALE_GRACE_MS,
};
