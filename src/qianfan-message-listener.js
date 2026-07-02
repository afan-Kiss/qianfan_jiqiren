/**
 * 千帆买家消息监听（CDP Network + WebSocket）
 * 本阶段：仅 WebSocket 实时消息触发微信通知
 */
const CDP = require('chrome-remote-interface');
const { fetchDevToolsJsonList, getPageTargets, DEVTOOLS_PORT, DEVTOOLS_HOST } = require('./devtools-list');
const { detectQianfanShopPages } = require('./page-finder');
const {
  extractMessagesFromResponse,
  filterBuyerOnlyMessages,
  isIgnoredMessage,
  parseMaybeJson,
  logUnknownMessageType,
} = require('./chat-parse');

const WATCH_PATHS = [
  '/api/impaas/message/user/list/batch',
  '/api/impaas/message/user/list',
  '/api/edith/cs/pc/message/latest/content',
  '/api/edith/cs/seller/get/unchecked/ai/msg',
];

function matchWatchPath(url) {
  const u = String(url || '');
  return WATCH_PATHS.some((p) => u.includes(p));
}
const {
  buildCanonicalBuyerMessageKey,
  saveSessionContext,
  hasNotifiedPersisted,
  getActiveSessionAppCids,
} = require('./qianfan-data-store');
const {
  registerQianfanWsBridge,
  registerBuyerMessageHandler,
  getBridgeWsActivity,
  fetchHttpTemplate,
  fetchMessageListForAppCid,
  getBridgeActiveAppCids,
  findBridgeByShopTitle,
  isBridgeCdpReady,
  markBridgeCdpClosed,
  noteBuyerAppCidOnBridge,
  registerShopReconnectWake,
  unregisterShopReconnectWake,
  prewarmShopWsSend,
} = require('./qianfan-ws-bridge');
const { onBuyerMessage: triggerCookieOnBuyerMessage, scheduleCookieRefresh, onShopSwitch } = require('./qianfan-cookie-collector');
const { triggerShopCookieUploadOnBuyerMessage, scheduleShopCookieAutoUpload } = require('./shop-cookie-uploader');
const { println } = require('./utils');
const {
  withTimeout,
  safeCloseCdp,
  cdpRuntimeEvaluate,
  cdpNetworkEnable,
  cdpNetworkDisable,
  cdpPageEnable,
  cdpGetResponseBody,
  CDP_EVAL_DEFAULT_MS,
} = require('./cdp-timeout');

const seenCanonicalKeys = new Set();
let heartbeatTimer = null;
let pollTimer = null;
let watchdogTimer = null;
let activeListenerHandle = null;
let lastHeartbeatAt = 0;
let lastBuyerMessageAt = 0;
let listenerStartedAt = 0;
const CDP_RECONNECT_MS = 5000;
const CDP_PING_MS = 30000;
const WS_STALE_MS = 120000;
const HTTP_POLL_MS = 25000;
const HTTP_RECENT_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 120000;
const WATCHDOG_MS = 90000;
const WS_GRACE_MS = 3 * 60 * 1000;
const CDP_ATTACH_TIMEOUT_MS = 15000;
const CDP_CLOSE_TIMEOUT_MS = 5000;
const SEEN_KEYS_MAX = 8000;
const PENDING_HTTP_MAX = 200;
const LOG_CLEANUP_EVERY = 240;
const HTTP_POLL_PRIORITY = [
  '/api/edith/cs/seller/get/unchecked/ai/msg',
  '/api/edith/cs/pc/message/latest/content',
  '/api/impaas/message/user/list',
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function releaseSeenBuyerMessage(message) {
  seenCanonicalKeys.delete(buildCanonicalBuyerMessageKey(message));
}

function trimSeenKeysIfNeeded() {
  if (seenCanonicalKeys.size <= SEEN_KEYS_MAX) return;
  const drop = Math.floor(SEEN_KEYS_MAX / 2);
  const iter = seenCanonicalKeys.values();
  for (let i = 0; i < drop; i++) {
    const next = iter.next();
    if (next.done) break;
    seenCanonicalKeys.delete(next.value);
  }
}

function formatDiagText(message) {
  return String(message?.text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function logBuyerMsgSeen(message, source) {
  println(
    `[诊断] buyer-msg seen shop=${message.shopTitle || ''} appCid=${message.appCid || ''} msgId=${message.msgId || ''} createAt=${message.createAt || 0} text=${formatDiagText(message)} source=${source || message.source || 'unknown'}`
  );
}

function mapIgnoreReasonToSkip(reason) {
  const r = String(reason || '');
  if (r.includes('客服自己') || r.includes('SELLER') || r.includes('CSA') || r.includes('BOT')) {
    return 'self_message';
  }
  if (r.includes('系统')) return 'system_message';
  if (r.includes('空消息')) return 'empty_text';
  if (r.includes('缺少 msgId')) return 'missing_msg_id';
  if (r.includes('缺少 appCid')) return 'missing_app_cid';
  return r || 'ignored';
}

function emitBuyerMessage(message, handlers, reasonRef, options = {}) {
  const source = options.source || message.source || 'unknown';
  logBuyerMsgSeen(message, source);

  if (isIgnoredMessage(message, reasonRef)) {
    const skipReason = mapIgnoreReasonToSkip(reasonRef.reason);
    println(
      `[诊断] notify-skip msgId=${message.msgId || ''} reason=${skipReason} detail=${reasonRef.reason || ''}`
    );
    if (reasonRef.reason === '客服自己消息') println('[忽略] 客服自己消息');
    else if (reasonRef.reason === '系统消息') println('[忽略] 系统消息');
    else if (reasonRef.reason === '空消息') println('[忽略] 空消息');
    else if (reasonRef.reason === '缺少 msgId') {
      println(`[忽略] 无法识别买家消息（缺少 msgId）：店铺=${message.shopTitle || ''} appCid=${message.appCid || ''}`);
    }
    return false;
  }

  const canonicalKey = buildCanonicalBuyerMessageKey(message);
  if (seenCanonicalKeys.has(canonicalKey)) {
    if (!hasNotifiedPersisted(message)) {
      println(
        `[诊断] listener_seen 但未通知，允许重试 msgId=${message.msgId || ''} dedupKey=${canonicalKey}`
      );
      seenCanonicalKeys.delete(canonicalKey);
    } else {
      println(
        `[诊断] notify-skip msgId=${message.msgId || ''} reason=listener_seen dedupKey=${canonicalKey}`
      );
      return false;
    }
  }
  seenCanonicalKeys.add(canonicalKey);
  trimSeenKeysIfNeeded();

  if (typeof handlers.onBuyerMessage === 'function') {
    saveSessionContext(message);
    noteBuyerAppCidOnBridge(message.shopTitle, message.appCid);

    const preview = String(message.text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (message.contentType === 'text' || (!message.isImage && preview)) {
      println(
        `[千帆] 买家消息：${message.shopTitle} ${message.buyerNick || '买家'} ${preview || '【空】'}`
      );
    } else if (message.contentType === 'unknown' || message.isUnknown) {
      logUnknownMessageType(message);
      println(`[千帆] 收到未知类型消息，已转为【未知消息】：msgId=${message.msgId || 'n/a'}`);
    } else if (message.contentType === 'image' || message.isImage) {
      const urlCount = Array.isArray(message.imageUrls) ? message.imageUrls.length : 0;
      println(
        `[千帆] 收到买家图片消息：店铺=${message.shopTitle} 买家=${message.buyerNick || '买家'} imageUrls=${urlCount}`
      );
    } else if (message.contentType === 'product') {
      println(
        `[千帆] 收到买家商品卡片：店铺=${message.shopTitle} 买家=${message.buyerNick || '买家'} msgId=${message.msgId || 'n/a'}`
      );
    } else if (message.contentType === 'order') {
      println(
        `[千帆] 收到买家订单消息：店铺=${message.shopTitle} 买家=${message.buyerNick || '买家'} msgId=${message.msgId || 'n/a'}`
      );
    }
    handlers.onBuyerMessage(message, { source, httpFallback: options.httpFallback === true });
    triggerCookieOnBuyerMessage(message);
    triggerShopCookieUploadOnBuyerMessage(message);
    lastHeartbeatAt = Date.now();
    lastBuyerMessageAt = Date.now();
  }
  return true;
}

function processBuyerMessages(messages, handlers, { httpSource = false, source = httpSource ? 'http' : 'ws' } = {}) {
  const recentCutoff = Date.now() - HTTP_RECENT_MS;
  const buyers = httpSource ? filterBuyerOnlyMessages(messages) : messages;
  for (const msg of buyers) {
    if (httpSource && msg.createAt && msg.createAt < recentCutoff) continue;
    msg.source = msg.source || source;
    const reasonRef = { reason: '' };
    emitBuyerMessage(msg, handlers, reasonRef, { source: msg.source, httpFallback: httpSource });
  }
}

async function pollAppCidHttpMessages(shopTitle, appCid, handlers, bridge) {
  const fetched = await fetchMessageListForAppCid(bridge, appCid);
  if (!fetched.ok || !fetched.body) return 0;

  const messages = filterBuyerOnlyMessages(
    extractMessagesFromResponse(fetched.body, shopTitle, `http_poll:app_cid:${appCid}`)
  );
  const recentCutoff = Date.now() - HTTP_RECENT_MS;
  let rescued = 0;

  for (const msg of messages) {
    if (msg.createAt && msg.createAt < recentCutoff) continue;
    if (hasNotifiedPersisted(msg)) continue;

    msg.source = 'http_fallback';
    println(
      `[兜底] 发现未通知买家消息 shop=${shopTitle} appCid=${appCid} msgId=${msg.msgId || ''} text=${formatDiagText(msg)}`
    );
    const reasonRef = { reason: '' };
    if (
      emitBuyerMessage(msg, handlers, reasonRef, {
        source: 'http_fallback',
        httpFallback: true,
      })
    ) {
      rescued += 1;
    }
  }
  return rescued;
}

async function pollShopHttpMessages(shopTitle, handlers) {
  try {
    const bridge = findBridgeByShopTitle(shopTitle);
    if (!isBridgeCdpReady(bridge)) return;

    let rescued = 0;
    const appCids = [
      ...new Set([...getBridgeActiveAppCids(bridge), ...getActiveSessionAppCids(shopTitle)]),
    ];

    if (bridge.lastMessageListRequest?.url) {
      for (const appCid of appCids) {
        rescued += await pollAppCidHttpMessages(shopTitle, appCid, handlers, bridge);
      }
    }

    for (const pathKey of HTTP_POLL_PRIORITY) {
      const tpl = bridge.httpTemplates?.get(pathKey);
      if (!tpl) continue;

      const fetched = await fetchHttpTemplate(bridge, tpl);
      if (!fetched.ok || !fetched.body) continue;

      const messages = filterBuyerOnlyMessages(
        extractMessagesFromResponse(fetched.body, shopTitle, `http_poll:${pathKey}`)
      );
      const recentCutoff = Date.now() - HTTP_RECENT_MS;

      for (const msg of messages) {
        if (msg.createAt && msg.createAt < recentCutoff) continue;
        if (hasNotifiedPersisted(msg)) continue;

        msg.source = 'http_fallback';
        println(
          `[兜底] 发现未通知买家消息 shop=${shopTitle} appCid=${msg.appCid || ''} msgId=${msg.msgId || ''} text=${formatDiagText(msg)}`
        );
        const reasonRef = { reason: '' };
        if (
          emitBuyerMessage(msg, handlers, reasonRef, {
            source: 'http_fallback',
            httpFallback: true,
          })
        ) {
          rescued += 1;
        }
      }
    }

    if (rescued > 0) {
      println(`[兜底] 本轮 HTTP 补发候选 ${rescued} 条：${shopTitle}`);
    }
  } catch (err) {
    println(`[千帆] HTTP 轮询异常（已忽略）：${shopTitle} ${err.message || err}`);
  }
}

function detachShopFromPolling(state, shopTitle) {
  if (shopTitle) state.shopTitles.delete(shopTitle);
  markBridgeCdpClosed(shopTitle);
}

async function attachPage(pageInfo, handlers, state) {
  let client;
  try {
    client = await withTimeout(
      CDP({ target: pageInfo.webSocketDebuggerUrl }),
      CDP_ATTACH_TIMEOUT_MS,
      'CDP attach'
    );
    const { Network, Page } = client;
    await cdpNetworkEnable(Network);
    try {
      await cdpPageEnable(Page);
    } catch {
      // ignore
    }

    const shopTitle = pageInfo.shopTitle || pageInfo.pageTitle || '';
    if (state?.lastAttachedShopTitle && state.lastAttachedShopTitle !== shopTitle) {
      onShopSwitch(shopTitle);
    }
    state.lastAttachedShopTitle = shopTitle;
    await registerQianfanWsBridge(pageInfo, client);
    if (state?.onWsBuyerMessages) {
      registerBuyerMessageHandler(shopTitle, state.onWsBuyerMessages);
    }
    println(`[千帆] 已注册发送桥接：${shopTitle}`);
    void prewarmShopWsSend(shopTitle).catch((err) => {
      println(`[千帆] 店铺 ${shopTitle} WS预热失败: ${err.message || err}`);
    });

    const pendingHttpResponses = new Map();

    Network.responseReceived((params) => {
      const url = params.response?.url || '';
      if (!matchWatchPath(url)) return;
      if (pendingHttpResponses.size >= PENDING_HTTP_MAX) {
        const firstKey = pendingHttpResponses.keys().next().value;
        if (firstKey != null) pendingHttpResponses.delete(firstKey);
      }
      pendingHttpResponses.set(params.requestId, shopTitle);
    });

    Network.loadingFinished((params) => {
      if (!pendingHttpResponses.has(params.requestId)) return;
      pendingHttpResponses.delete(params.requestId);

      setImmediate(() => {
        void (async () => {
          try {
            const body = await cdpGetResponseBody(Network, params.requestId);
            const parsed = parseMaybeJson(body?.body);
            if (!parsed) return;
            const messages = extractMessagesFromResponse(parsed, shopTitle);
            processBuyerMessages(messages, handlers, { httpSource: true });
          } catch {
            // ignore single response errors
          }
        })();
      });
    });

    return { client, shopTitle };
  } catch (err) {
    if (client) {
      await safeCloseCdp(client, pageInfo.shopTitle, 'attach_fail', CDP_CLOSE_TIMEOUT_MS);
    }
    throw err;
  }
}

async function pingCdpClient(client) {
  try {
    const { Runtime } = client;
    if (!Runtime) return false;
    await cdpRuntimeEvaluate(Runtime, { expression: '1', returnByValue: true });
    return true;
  } catch {
    return false;
  }
}

async function refreshNetworkDomain(client) {
  try {
    const { Network } = client;
    if (!Network) return false;
    await cdpNetworkDisable(Network);
    await cdpNetworkEnable(Network);
    return true;
  } catch {
    return false;
  }
}

function formatIdleSeconds(ts) {
  if (!ts) return '从未';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec} 秒前`;
  return `${Math.floor(sec / 60)} 分钟前`;
}

async function isWsTrafficStale(shopTitle) {
  const activity = getBridgeWsActivity(shopTitle);
  const connectedAt = activity.connectedAt || 0;
  if (connectedAt && Date.now() - connectedAt < WS_GRACE_MS) return false;

  const lastAt = Math.max(activity.lastWsFrameAt || 0, activity.lastActivityAt || 0);
  if (lastAt) return Date.now() - lastAt >= WS_STALE_MS;
  return connectedAt > 0 && Date.now() - connectedAt >= WS_STALE_MS * 2;
}

async function resolveShopPage(shopTitle, port, host, expectedShopCount) {
  const list = await fetchDevToolsJsonList(port, host);
  const report = detectQianfanShopPages(getPageTargets(list), { expectedShopCount });
  return report.shops.find((shop) => shop.shopTitle === shopTitle) || null;
}

async function maintainPageConnection(initialPageInfo, handlers, state) {
  let pageInfo = initialPageInfo;
  const shopTitle = pageInfo.shopTitle || pageInfo.pageTitle || '未知店铺';

  while (!state.stopped) {
    let client = null;
    let shopTitleRef = shopTitle;
    let pingTimer = null;
    let reconnectRequested = false;
    let reconnectReason = '';
    let closedByRequest = false;
    let wakeReconnect = null;

    const requestReconnect = (reason) => {
      if (reconnectRequested) return;
      reconnectRequested = true;
      reconnectReason = reason;
      closedByRequest = true;

      println(`[千帆] 请求重连：${shopTitleRef} reason=${reason}`);

      detachShopFromPolling(state, shopTitleRef);

      if (wakeReconnect) {
        wakeReconnect(reason || 'reconnect_requested');
        wakeReconnect = null;
      }

      void safeCloseCdp(client, shopTitleRef, reason, CDP_CLOSE_TIMEOUT_MS);
    };

    try {
      const attached = await attachPage(pageInfo, handlers, state);
      client = attached.client;
      shopTitleRef = attached.shopTitle;
      reconnectRequested = false;
      reconnectReason = '';
      closedByRequest = false;
      state.clients.add(client);
      state.shopTitles.add(shopTitleRef);
      println(`[千帆] 监听已连接：${shopTitleRef}`);

      state.reconnectPending?.delete(shopTitleRef);

      const disconnectPromise = new Promise((resolve) => {
        client.on('disconnect', () => {
          if (!reconnectRequested) {
            reconnectRequested = true;
            reconnectReason = 'disconnect';
            detachShopFromPolling(state, shopTitleRef);
          }
          resolve('disconnect');
        });
      });

      const reconnectSignal = new Promise((resolve) => {
        wakeReconnect = resolve;
      });

      registerShopReconnectWake(shopTitleRef, requestReconnect);

      pingTimer = setInterval(() => {
        void (async () => {
          try {
            if (state.stopped || !client || reconnectRequested) return;
            if (state.pingInFlight?.has(shopTitleRef)) return;
            state.pingInFlight.add(shopTitleRef);
            state.pingStartedAt.set(shopTitleRef, Date.now());

            const runtimeOk = await pingCdpClient(client);
            if (!runtimeOk) {
              println(`[千帆] CDP 心跳失败：${shopTitleRef}，准备重连...`);
              requestReconnect('cdp_ping_fail');
              return;
            }

            const stale = await isWsTrafficStale(shopTitleRef);
            if (!stale) return;

            const refreshed = await refreshNetworkDomain(client);
            if (refreshed) {
              println(`[千帆] ${shopTitleRef} impaas 停滞，已刷新 Network`);
            }

            const stillStale = await isWsTrafficStale(shopTitleRef);
            if (!stillStale) return;

            println(`[千帆] ${shopTitleRef} 超过 ${WS_STALE_MS / 1000}s 无 impaas 流量，重连中...`);
            requestReconnect('impaas_stale');
          } catch (err) {
            println(`[千帆] 心跳检测异常（${shopTitleRef}）：${err.message || err}`);
            requestReconnect('ping_error');
          } finally {
            state.pingInFlight.delete(shopTitleRef);
            state.pingStartedAt.delete(shopTitleRef);
          }
        })();
      }, CDP_PING_MS);

      const endReason = await Promise.race([
        disconnectPromise.then(() => 'disconnect'),
        reconnectSignal.then((reason) => reason || 'reconnect_requested'),
      ]);

      if (endReason) {
        reconnectReason = reconnectReason || endReason;
      }

      if (reconnectReason) {
        println(`[千帆] ${shopTitleRef} 连接结束：${reconnectReason}`);
      }
    } catch (err) {
      println(`[千帆] 监听连接失败：${shopTitle} - ${err.message || err}`);
    } finally {
      unregisterShopReconnectWake(shopTitleRef);
      if (pingTimer) clearInterval(pingTimer);
      if (client) {
        detachShopFromPolling(state, shopTitleRef);
        state.clients.delete(client);
        if (!closedByRequest) {
          await safeCloseCdp(client, shopTitleRef, 'finally', CDP_CLOSE_TIMEOUT_MS);
        }
      }
    }

    if (state.stopped) break;

    println(`[千帆] ${CDP_RECONNECT_MS / 1000} 秒后重连：${shopTitle}`);
    await sleep(CDP_RECONNECT_MS);

    try {
      const updated = await resolveShopPage(shopTitle, state.port, state.host, state.expectedShopCount);
      if (updated) {
        pageInfo = updated;
      } else {
        println(`[千帆] 暂未找到店铺页面：${shopTitle}，继续重试...`);
      }
    } catch (err) {
      println(`[千帆] 刷新店铺页面失败：${err.message || err}`);
    }
  }
}

function summarizeWsActivity(state) {
  let maxIdleSec = 0;
  let staleCount = 0;
  for (const title of state.shopTitles || []) {
    const act = getBridgeWsActivity(title);
    const lastAt = Math.max(act.lastWsFrameAt || 0, act.lastActivityAt || 0);
    const idleSec = lastAt ? Math.floor((Date.now() - lastAt) / 1000) : 9999;
    if (idleSec > maxIdleSec) maxIdleSec = idleSec;
    if (!lastAt || idleSec >= WS_STALE_MS / 1000) staleCount += 1;
  }
  return { maxIdleSec, staleCount };
}

function startHeartbeat(state) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    const connected = state?.clients?.size || 0;
    const buyerIdle = formatIdleSeconds(lastBuyerMessageAt);
    const { maxIdleSec, staleCount } = summarizeWsActivity(state);

    println(
      `[千帆] 监听中 ${connected}店 | 上次买家消息 ${buyerIdle} | impaas最久 ${maxIdleSec >= 9999 ? '无' : `${maxIdleSec}s`}${staleCount ? ` | ${staleCount}店待刷新` : ''}`
    );
    lastHeartbeatAt = Date.now();
  }, HEARTBEAT_MS);
}

function startWatchdog(state) {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    if (state.stopped) return;
    const connected = state.clients?.size || 0;
    const polls = state.pollInFlight?.size || 0;
    const pings = state.pingInFlight?.size || 0;
    println(`[千帆] 存活 ${connected}店连接 HTTP轮询${polls} 心跳${pings}`);

    const now = Date.now();
    for (const [shop, startedAt] of state.pingStartedAt || []) {
      if (now - startedAt > CDP_EVAL_DEFAULT_MS + 5000) {
        state.pingInFlight.delete(shop);
        state.pingStartedAt.delete(shop);
        println(`[千帆] 心跳卡住已复位：${shop}`);
      }
    }

    state._watchdogTicks = (state._watchdogTicks || 0) + 1;
    if (state._watchdogTicks % LOG_CLEANUP_EVERY === 0) {
      try {
        const { cleanupDebugLogs } = require('./log-maintenance');
        cleanupDebugLogs();
      } catch {
        // ignore
      }
    }
  }, WATCHDOG_MS);
}

function startHttpPolling(state, handlers) {
  if (pollTimer) clearInterval(pollTimer);
  state.pollInFlight = state.pollInFlight || new Set();
  pollTimer = setInterval(() => {
    if (state.stopped) return;
    for (const shopTitle of [...(state.shopTitles || [])]) {
      if (state.pollInFlight.has(shopTitle)) continue;
      state.pollInFlight.add(shopTitle);
      void pollShopHttpMessages(shopTitle, handlers).finally(() => {
        state.pollInFlight.delete(shopTitle);
      });
    }
  }, HTTP_POLL_MS);
}

/**
 * @param {{
 *   onBuyerMessage?: Function,
 *   devtoolsPort?: number,
 *   devtoolsHost?: string,
 *   expectedShopCount?: number,
 *   pages?: Array,
 *   shopReport?: object,
 * }} options
 */
async function teardownActiveListener() {
  if (activeListenerHandle?.stop) {
    try {
      await activeListenerHandle.stop();
    } catch {
      // ignore teardown failures
    }
  }
  activeListenerHandle = null;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function startQianfanMessageListener(options = {}) {
  await teardownActiveListener();

  const port = options.devtoolsPort || DEVTOOLS_PORT;
  const host = options.devtoolsHost || DEVTOOLS_HOST;
  const handlers = { onBuyerMessage: options.onBuyerMessage };
  const expectedShopCount = Number(options.expectedShopCount || 4);

  listenerStartedAt = Date.now();
  seenCanonicalKeys.clear();

  let pages = Array.isArray(options.pages) ? options.pages : null;
  if (!pages && options.shopReport?.shops?.length) {
    pages = options.shopReport.shops;
  }

  if (!pages) {
    let list;
    try {
      list = await fetchDevToolsJsonList(port, host);
    } catch (err) {
      throw new Error(`千帆 DevTools ${port} 不可访问：${err.message || err}`);
    }
    const report = detectQianfanShopPages(getPageTargets(list), { expectedShopCount });
    pages = report.shops;
  }

  if (!pages.length) {
    throw new Error('未找到千帆店铺工作台页面，无法启动监听');
  }

  const seenShopTitles = new Set();
  pages = pages.filter((page) => {
    const key = String(page.shopTitle || page.pageTitle || '').trim();
    if (!key || seenShopTitles.has(key)) return false;
    seenShopTitles.add(key);
    return true;
  });

  if (!pages.length) {
    throw new Error('未找到千帆店铺工作台页面，无法启动监听');
  }

  const state = {
    stopped: false,
    port,
    host,
    expectedShopCount,
    clients: new Set(),
    shopTitles: new Set(),
    reconnectPending: new Set(),
    pingInFlight: new Set(),
    pingStartedAt: new Map(),
    pollInFlight: new Set(),
    onWsBuyerMessages: (messages) => processBuyerMessages(messages, handlers),
  };

  for (const page of pages) {
    void maintainPageConnection(page, handlers, state);
  }

  lastHeartbeatAt = Date.now();
  lastBuyerMessageAt = 0;
  startHeartbeat(state);
  startWatchdog(state);
  startHttpPolling(state, handlers);
  scheduleCookieRefresh();
  scheduleShopCookieAutoUpload();

  activeListenerHandle = {
    pages,
    stop: async () => {
      state.stopped = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      for (const client of [...state.clients]) {
        await safeCloseCdp(client, 'shutdown', 'stop', CDP_CLOSE_TIMEOUT_MS);
      }
      state.clients.clear();
      state.shopTitles.clear();
      if (activeListenerHandle?.pages === pages) {
        activeListenerHandle = null;
      }
    },
  };
  return activeListenerHandle;
}

module.exports = {
  startQianfanMessageListener,
  detectQianfanShopPages,
  releaseSeenBuyerMessage,
};
