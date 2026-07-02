/**
 * 登录阶段全局 CDP 抓包：在店铺 bridge 接入前，监听登录页/SSO/二维码相关流量
 */
const CDP = require('chrome-remote-interface');
const { fetchDevToolsJsonList } = require('../devtools-list');
const { isWorkbenchPage, isQianfanRelatedPage } = require('../page-finder');
const { println } = require('../utils');
const {
  isProtocolTapEnabled,
  isLoginOrAuthUrl,
  createPseudoBridge,
  maybeTapHttpRequest,
  maybeTapHttpResponse,
  maybeTapHttpLoadingFinished,
  maybeTapWsCreated,
  maybeTapWsHandshakeRequest,
  maybeTapWsHandshakeResponse,
  maybeTapWsFrame,
  appendTapSessionMilestone,
} = require('./qianfan-protocol-tap');
const { safeCloseCdp, cdpNetworkEnable } = require('../cdp-timeout');
const {
  attachTapCookieListeners,
  scheduleTapCookieSnapshot,
  snapshotTapCookie,
  collectTapCookiesFromBridges,
  shouldPollCookieSnapshot,
} = require('./qianfan-protocol-tap-cookie');

const globalState = {
  running: false,
  attached: new Map(),
  pollTimer: null,
  port: 9322,
  host: '127.0.0.1',
  lastMergedCookie: '',
  lastCookieSummary: null,
};

function shouldGlobalTapTarget(target) {
  if (!target?.webSocketDebuggerUrl) return false;
  const url = String(target.url || '');
  if (!url || url.startsWith('devtools://') || url.startsWith('chrome://')) return false;
  if (isWorkbenchPage(target)) return false;
  if (isLoginOrAuthUrl(url)) return true;
  if (isQianfanRelatedPage(target)) return true;
  return /xiaohongshu|longlink|impaas|walle|edith/i.test(url);
}

function targetKey(target) {
  return String(target.id || target.webSocketDebuggerUrl || target.url || '');
}

async function attachGlobalTapTarget(target) {
  const key = targetKey(target);
  if (!key || globalState.attached.has(key)) return globalState.attached.get(key);

  const pageInfo = {
    title: target.title || '',
    pageTitle: target.title || '',
    shopTitle: isLoginOrAuthUrl(target.url) ? '登录页' : target.title || '千帆页面',
    url: target.url || '',
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
  };
  const bridge = createPseudoBridge(pageInfo);
  bridge.client = null;

  let client;
  try {
    client = await CDP({ target: target.webSocketDebuggerUrl });
    await cdpNetworkEnable(client.Network);
    attachTapCookieListeners(client, bridge);
    bridge.client = client;

    client.Network.requestWillBeSent((params) => {
      maybeTapHttpRequest(bridge, params);
    });
    client.Network.responseReceived((params) => {
      maybeTapHttpResponse(bridge, params);
    });
    client.Network.loadingFinished((params) => {
      void maybeTapHttpLoadingFinished(bridge, params);
    });
    client.Network.webSocketCreated((params) => {
      const requestId = String(params.requestId || '');
      const wsUrl = String(params.url || '');
      if (requestId && wsUrl) bridge.wsUrls.set(requestId, wsUrl);
      maybeTapWsCreated(bridge, params);
    });
    client.Network.webSocketWillSendHandshakeRequest((params) => {
      const requestId = String(params.requestId || '');
      const request = params.request || {};
      const url = bridge.wsUrls.get(requestId) || '';
      bridge.wsHandshakeHeaders.set(requestId, {
        requestHeaders: request.headers || {},
        url,
      });
      maybeTapWsHandshakeRequest(bridge, requestId, request, url);
    });
    client.Network.webSocketHandshakeResponseReceived((params) => {
      const requestId = String(params.requestId || '');
      const response = params.response || {};
      const url = bridge.wsUrls.get(requestId) || '';
      maybeTapWsHandshakeResponse(bridge, requestId, response, url);
    });
    client.Network.webSocketFrameReceived((params) => {
      maybeTapWsFrame(bridge, params.response?.payloadData, 'received', params.requestId);
    });
    client.Network.webSocketFrameSent((params) => {
      maybeTapWsFrame(bridge, params.response?.payloadData, 'sent', params.requestId);
    });

    client.on('disconnect', () => {
      globalState.attached.delete(key);
    });

    globalState.attached.set(key, { bridge, client, target, attachedAt: Date.now() });
    appendTapSessionMilestone({
      shopTitle: bridge.shopTitle,
      phase: bridge.phase,
      pageUrl: bridge.pageUrl,
      milestone: 'global_cdp_attached',
      title: pageInfo.title,
    });
    println(`[协议抓包][全局] 已接入页面 phase=${bridge.phase} title=${pageInfo.title} url=${pageInfo.url}`);
    setTimeout(() => {
      scheduleTapCookieSnapshot(bridge, 'global_attach', { networkHeaderWaitMs: 2000 });
    }, 3000);
    return globalState.attached.get(key);
  } catch (err) {
    if (client) await safeCloseCdp(client, bridge.shopTitle, 'global_tap_fail');
    println(`[协议抓包][全局] 接入失败 ${pageInfo.url}: ${err.message || err}`);
    return null;
  }
}

async function pollGlobalTargets() {
  if (!globalState.running || !isProtocolTapEnabled()) return;
  let list = [];
  try {
    list = await fetchDevToolsJsonList(globalState.port, globalState.host);
  } catch {
    return;
  }
  const targets = list.filter((target) => {
    if (!target?.webSocketDebuggerUrl) return false;
    if (target.type === 'page') return shouldGlobalTapTarget(target);
    if (target.type === 'iframe') return isLoginOrAuthUrl(String(target.url || ''));
    return false;
  });
  for (const target of targets) {
    void attachGlobalTapTarget(target);
  }
  for (const row of globalState.attached.values()) {
    if (row.bridge?.client && shouldPollCookieSnapshot(row.bridge)) {
      scheduleTapCookieSnapshot(row.bridge, 'global_poll', { networkHeaderWaitMs: 800 });
    }
  }
}

function startGlobalProtocolTap(options = {}) {
  if (globalState.running) return { ok: true, alreadyRunning: true, attached: globalState.attached.size };
  globalState.running = true;
  globalState.port = Number(options.devtoolsPort || options.port || 9322);
  globalState.host = String(options.devtoolsHost || options.host || '127.0.0.1');
  const pollMs = Number(options.pollMs || 2000);

  appendTapSessionMilestone({
    shopTitle: 'SESSION',
    phase: 'login',
    milestone: 'global_tap_started',
    devtoolsPort: globalState.port,
  });
  println(`[协议抓包][全局] 登录阶段抓包已启动，轮询 DevTools ${globalState.host}:${globalState.port}`);

  void pollGlobalTargets();
  globalState.pollTimer = setInterval(() => void pollGlobalTargets(), pollMs);
  return { ok: true, port: globalState.port, host: globalState.host, pollMs };
}

async function stopGlobalProtocolTap() {
  globalState.running = false;
  if (globalState.pollTimer) clearInterval(globalState.pollTimer);
  globalState.pollTimer = null;
  for (const [key, row] of globalState.attached.entries()) {
    try {
      if (row.client) await safeCloseCdp(row.client, row.bridge?.shopTitle || key, 'global_tap_stop');
    } catch {
      // ignore
    }
  }
  globalState.attached.clear();
  appendTapSessionMilestone({
    shopTitle: 'SESSION',
    phase: 'login',
    milestone: 'global_tap_stopped',
  });
}

function getGlobalProtocolTapStatus() {
  return {
    running: globalState.running,
    attachedCount: globalState.attached.size,
    attachedPages: [...globalState.attached.values()].map((row) => ({
      shopTitle: row.bridge?.shopTitle,
      phase: row.bridge?.phase,
      pageUrl: row.bridge?.pageUrl,
      title: row.target?.title,
      attachedAt: row.attachedAt,
      lastTapCookieSnapshotAt: row.bridge?.lastTapCookieSnapshotAt || 0,
    })),
    port: globalState.port,
    host: globalState.host,
    lastMergedCookieLength: globalState.lastMergedCookie?.length || 0,
    lastCookieSummary: globalState.lastCookieSummary,
  };
}

async function collectGlobalTapCookies(options = {}) {
  const bridges = [...globalState.attached.values()].map((row) => row.bridge).filter(Boolean);
  const result = await collectTapCookiesFromBridges(bridges, {
    reason: options.reason || 'global_collect',
    networkHeaderWaitMs: Number(options.networkHeaderWaitMs ?? 1500),
  });
  if (result.ok) {
    globalState.lastMergedCookie = result.cookie;
    globalState.lastCookieSummary = result.summary;
  }
  return result;
}

module.exports = {
  startGlobalProtocolTap,
  stopGlobalProtocolTap,
  getGlobalProtocolTapStatus,
  collectGlobalTapCookies,
  snapshotGlobalTapCookie: snapshotTapCookie,
  shouldGlobalTapTarget,
};
