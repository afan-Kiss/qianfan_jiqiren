/**
 * 协议抓包 Cookie 补采：CDP Cookie Jar + Network 请求头合并
 * Electron 下 requestWillBeSent 常不带 Cookie 头，需 getAllCookies / ExtraInfo 兜底。
 */
const { println } = require('../utils');
const { summarizeCookie } = require('../protocol/qianfan-protocol-config');

const COOKIE_SNAPSHOT_DEBOUNCE_MS = 2500;
const COOKIE_POLL_MIN_MS = 60 * 1000;

const pendingByBridge = new Map();
const lastSnapshotAtByBridge = new Map();

const LOGIN_COOKIE_TRIGGER_RE =
  /\/get_login_user|\/switch_eva_login_user|\/impaas\/token\/v2|service-ticket|ticket-granting-ticket|\/cas\/customer\/pc\/qr-code/i;

function lazyRecordTap() {
  return require('./qianfan-protocol-tap').recordTap;
}

function lazyFullCookie() {
  return require('../qianfan-full-cookie-collect');
}

function bridgeKey(bridge) {
  return String(bridge?.shopTitle || bridge?.pageUrl || 'bridge');
}

function shouldTriggerCookieSnapshot(url, responseBody = '') {
  const u = String(url || '');
  if (!LOGIN_COOKIE_TRIGGER_RE.test(u)) return false;
  const body = String(responseBody || '');
  if (/\/qr-code/i.test(u) && /"status"\s*:\s*1/.test(body) && /"ticket"\s*:/.test(body)) return true;
  if (/\/get_login_user|\/switch_eva_login_user/i.test(u) && /"success"\s*:\s*true/i.test(body)) return true;
  if (/\/impaas\/token\/v2/i.test(u) && /accessToken/i.test(body)) return true;
  if (/service-ticket/i.test(u)) return true;
  return false;
}

function cookieScore(cookie, summary) {
  let score = Number(summary?.length || cookie?.length || 0);
  if (summary?.hasA1) score += 500;
  if (summary?.hasWalleToken) score += 800;
  if (summary?.hasArkToken) score += 400;
  if (summary?.hasWebSession) score += 200;
  return score;
}

async function snapshotTapCookie(bridge, reason = 'manual', options = {}) {
  if (!bridge?.client) return null;
  const { collectFullCookiesFromBridge } = lazyFullCookie();
  const waitMs = Number(options.networkHeaderWaitMs ?? 1200);
  try {
    const collected = await collectFullCookiesFromBridge(bridge, {
      readOnly: true,
      requireRecentNetworkHeader: false,
      networkHeaderWaitMs: waitMs,
      includeJarFallback: true,
      logDiagnostics: options.logDiagnostics === true,
    });
    const cookie = String(collected?.cookie || '').trim();
    if (!cookie || cookie.length < 20) {
      return collected?.skipped ? { ok: false, skipped: true, reason: collected.reason } : { ok: false, error: 'empty_cookie' };
    }
    const summary = summarizeCookie(cookie);
    if (!options.silent) {
      const recordTap = lazyRecordTap();
      recordTap(bridge, {
        kind: 'cookie_snapshot',
        reason,
        cookie,
        cookieLength: cookie.length,
        cookieKeysPreview: summary.keysPreview || [],
        cookieSummary: {
          hasA1: summary.hasA1,
          hasWebSession: summary.hasWebSession,
          hasAccessToken: summary.hasAccessToken,
          hasArkToken: summary.hasArkToken,
          hasWalleToken: summary.hasWalleToken,
          length: summary.length,
        },
        sources: collected?.sources || {},
        cookieHash: collected?.cookieHash || '',
      });
    }
    bridge.mergedNetworkHeaderCookie = cookie;
    bridge.lastTapCookieSnapshotAt = Date.now();
    bridge.lastTapCookieSnapshotReason = reason;
    lastSnapshotAtByBridge.set(bridgeKey(bridge), Date.now());
    if (!options.silent) {
      println(
        `[协议抓包][Cookie] ${bridge.shopTitle || '-'} reason=${reason} len=${cookie.length} a1=${summary.hasA1} walle=${summary.hasWalleToken} keys=${(summary.keysPreview || []).slice(0, 8).join(',')}`
      );
    }
    return { ok: true, cookie, summary, collected };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

function scheduleTapCookieSnapshot(bridge, reason = 'scheduled', options = {}) {
  if (!bridge?.client) return;
  const key = bridgeKey(bridge);
  const prev = pendingByBridge.get(key);
  if (prev) clearTimeout(prev);
  const debounceMs = Number(options.debounceMs ?? COOKIE_SNAPSHOT_DEBOUNCE_MS);
  const timer = setTimeout(() => {
    pendingByBridge.delete(key);
    void snapshotTapCookie(bridge, reason, options);
  }, debounceMs);
  pendingByBridge.set(key, timer);
}

function attachTapCookieListeners(client, bridge) {
  if (!client || !bridge) return;
  const { ensureBridgeNetworkHeaderListeners } = lazyFullCookie();
  ensureBridgeNetworkHeaderListeners(client, bridge);
  bridge._tapCookieListenersAttached = true;
}

async function collectTapCookiesFromBridges(bridges = [], options = {}) {
  const { mergeCookiePartsPreferLongest, cookieContainsWalleToken } = lazyFullCookie();
  const waitMs = Number(options.networkHeaderWaitMs ?? 1500);
  const rows = [];
  for (const bridge of bridges) {
    if (!bridge?.client) continue;
    const snap = await snapshotTapCookie(bridge, options.reason || 'collect_batch', {
      networkHeaderWaitMs: waitMs,
      logDiagnostics: false,
      silent: bridges.length > 1,
    });
    if (snap?.ok && snap.cookie) rows.push(snap);
  }
  if (!rows.length) return { ok: false, error: 'no_cookie_snapshots' };
  const cookies = rows.map((r) => r.cookie);
  const merged = mergeCookiePartsPreferLongest(...cookies);
  const summary = summarizeCookie(merged);
  const best = rows.reduce((a, b) => (cookieScore(b.cookie, b.summary) > cookieScore(a.cookie, a.summary) ? b : a), rows[0]);
  if (bridges.length > 1) {
    const recordTap = lazyRecordTap();
    recordTap(bridges[0], {
      kind: 'cookie_snapshot',
      reason: options.reason || 'collect_batch',
      cookie: merged,
      cookieLength: merged.length,
      cookieKeysPreview: summary.keysPreview || [],
      cookieSummary: {
        hasA1: summary.hasA1,
        hasWebSession: summary.hasWebSession,
        hasAccessToken: summary.hasAccessToken,
        hasArkToken: summary.hasArkToken,
        hasWalleToken: summary.hasWalleToken,
        length: summary.length,
      },
      snapshotCount: rows.length,
    });
    println(
      `[协议抓包][Cookie] merged reason=${options.reason || 'collect_batch'} len=${merged.length} walle=${summary.hasWalleToken} from=${rows.length} pages`
    );
  }
  return {
    ok: true,
    cookie: merged,
    summary,
    bestBridge: best?.collected?.shopName || '',
    snapshotCount: rows.length,
    hasWalleToken: cookieContainsWalleToken(merged),
  };
}

function shouldPollCookieSnapshot(bridge) {
  const last = lastSnapshotAtByBridge.get(bridgeKey(bridge)) || 0;
  return Date.now() - last >= COOKIE_POLL_MIN_MS;
}

module.exports = {
  COOKIE_SNAPSHOT_DEBOUNCE_MS,
  COOKIE_POLL_MIN_MS,
  shouldTriggerCookieSnapshot,
  attachTapCookieListeners,
  scheduleTapCookieSnapshot,
  snapshotTapCookie,
  collectTapCookiesFromBridges,
  shouldPollCookieSnapshot,
};
