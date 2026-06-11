const fs = require('fs');
const path = require('path');
const CDP = require('chrome-remote-interface');
const { getDoudianConfig } = require('../../shared/config');
const { println } = require('../../shared/logger');
const { cdpRuntimeEvaluate, cdpAddScriptToEvaluateOnNewDocument, withTimeout } = require('../../shared/cdp-utils');
const { findDoudianPages } = require('./doudian-page-finder');
const { BRIDGE_EVENTS } = require('./doudian-types');

const INJECT_READY_TIMEOUT_MS = 20000;
const INJECT_SCRIPT_PATH = path.join(__dirname, 'injected', 'doudian-web-bridge.js');

function readInjectScript() {
  return fs.readFileSync(INJECT_SCRIPT_PATH, 'utf8');
}

function buildBootstrapExpression(bridgePort, extraConfig = {}) {
  const cfg = getDoudianConfig();
  const script = readInjectScript();
  const wsUrl = `ws://127.0.0.1:${bridgePort}/doudian/bridge`;
  const configPayload = {
    heartbeatIntervalMs: cfg.heartbeatIntervalMs,
    selectors: cfg.selectors,
    debugRawPayload: cfg.debugRawPayload,
    ...extraConfig,
  };
  return `(async function(){
    ${script}
    var bridge = window.__DOUDIAN_BRIDGE__ || window.__DOUDIAN_BRIDGE;
    if (bridge) {
      bridge.configure(${JSON.stringify(configPayload)});
      bridge.connect(${JSON.stringify(wsUrl)});
      return bridge.getState();
    }
    return { ok: false, reason: 'bridge_missing' };
  })()`;
}

async function connectCdpPage(pageInfo) {
  if (!pageInfo?.webSocketDebuggerUrl) {
    throw new Error('页面缺少 webSocketDebuggerUrl');
  }
  const client = await CDP({ target: pageInfo.webSocketDebuggerUrl });
  await client.Runtime.enable();
  await client.Page.enable();
  return client;
}

async function checkBridgeExists(client) {
  const result = await cdpRuntimeEvaluate(client.Runtime, {
    expression: `(function(){
      var bridge = window.__DOUDIAN_BRIDGE__ || window.__DOUDIAN_BRIDGE;
      if (bridge && bridge.__installed) {
        return { exists: true, state: bridge.getState() };
      }
      return { exists: false };
    })()`,
    returnByValue: true,
  });
  return result?.result?.value || { exists: false };
}

async function injectBridge(client, bridgePort, extraConfig = {}) {
  const script = readInjectScript();
  try {
    await cdpAddScriptToEvaluateOnNewDocument(client.Page, script);
  } catch {
    // ignore
  }

  const expression = buildBootstrapExpression(bridgePort, extraConfig);
  const result = await cdpRuntimeEvaluate(client.Runtime, {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, 15000);

  return result?.result?.value || { ok: false, reason: 'eval_empty' };
}

async function waitBridgeReady(wsServer, bridgeId, timeoutMs = INJECT_READY_TIMEOUT_MS) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('WebSocket 没连上本地服务或 bridge.ready 超时'));
    }, timeoutMs);

    function onAny(envelope) {
      if (envelope.bridgeId !== bridgeId) return;
      if (envelope.type === BRIDGE_EVENTS.READY) {
        cleanup();
        resolve(envelope);
      }
      if (envelope.type === BRIDGE_EVENTS.ERROR) {
        cleanup();
        reject(new Error(envelope.payload?.message || 'bridge.error'));
      }
    }

    function cleanup() {
      clearTimeout(timer);
      off && off();
    }

    const off = wsServer.on('*', onAny);

    const existing = wsServer.getBridgeState(bridgeId);
    if (existing?.ready) {
      cleanup();
      resolve({ bridgeId, type: BRIDGE_EVENTS.READY, payload: existing });
    }
  });
}

async function injectDoudianBridge(options = {}) {
  const cfg = getDoudianConfig();
  const bridgePort = Number(options.bridgePort || cfg.bridgePort || 19527);
  const pageInfo = options.pageInfo;
  const wsServer = options.wsServer;

  if (!pageInfo) {
    println('注入失败：找不到 DevTools 页面');
    return { ok: false, reason: 'page_not_found' };
  }

  if (!pageInfo.isServicePage && !options.force) {
    println(`注入失败：页面不是客服页 title=${pageInfo.title} url=${pageInfo.url}`);
    return { ok: false, reason: 'not_service_page', pageInfo };
  }

  println(`正在注入 bridge pageId=${pageInfo.pageId} title=${pageInfo.title}`);

  let client;
  try {
    client = await withTimeout(connectCdpPage(pageInfo), 10000, 'CDP connect');
  } catch (err) {
    println(`注入失败：CDP 连接失败 ${err.message || err}`);
    return { ok: false, reason: 'cdp_connect_failed', error: String(err.message || err) };
  }

  try {
    const exists = await checkBridgeExists(client);
    if (exists.exists) {
      println(`bridge 已存在，跳过重复注入 bridgeId=${exists.state?.bridgeId || ''}`);
      return {
        ok: true,
        already: true,
        pageId: pageInfo.pageId,
        title: pageInfo.title,
        url: pageInfo.url,
        bridgeId: exists.state?.bridgeId || '',
        injectedAt: Date.now(),
        client,
      };
    }

    const injectResult = await injectBridge(client, bridgePort);
    const bridgeId = injectResult?.bridgeId || injectResult?.state?.bridgeId || '';

    if (!bridgeId) {
      println(`注入失败：Runtime.evaluate 未返回 bridgeId`);
      await client.close().catch(() => {});
      return { ok: false, reason: 'runtime_evaluate_failed', injectResult };
    }

    if (wsServer) {
      try {
        await waitBridgeReady(wsServer, bridgeId, options.readyTimeoutMs || INJECT_READY_TIMEOUT_MS);
        println(`bridge 已连接 bridgeId=${bridgeId}`);
      } catch (err) {
        println(`注入后等待 bridge.ready 失败：${err.message || err}`);
        return {
          ok: false,
          reason: 'bridge_not_connected',
          bridgeId,
          pageId: pageInfo.pageId,
          title: pageInfo.title,
          url: pageInfo.url,
          error: String(err.message || err),
        };
      }
    }

    return {
      ok: true,
      pageId: pageInfo.pageId,
      title: pageInfo.title,
      url: pageInfo.url,
      bridgeId,
      injectedAt: Date.now(),
      client,
    };
  } catch (err) {
    println(`注入失败：Runtime.evaluate 异常 ${err.message || err}`);
    try {
      await client.close();
    } catch {
      // ignore
    }
    return { ok: false, reason: 'runtime_evaluate_failed', error: String(err.message || err) };
  }
}

async function findAndInject(options = {}) {
  const devtools = options.devtools;
  if (!devtools?.ok) {
    println('注入失败：找不到抖店进程/DevTools 端口');
    return { ok: false, reason: 'devtools_not_found' };
  }

  const report = findDoudianPages(devtools.pages || devtools.list || [], {
    devtoolsPort: devtools.port,
  });

  const target = options.pageInfo || report.bestServicePage;
  if (!target) {
    println('注入失败：找不到抖店客服页');
    return { ok: false, reason: 'service_page_not_found', report };
  }

  return injectDoudianBridge({
    ...options,
    pageInfo: target,
  });
}

module.exports = {
  readInjectScript,
  buildBootstrapExpression,
  connectCdpPage,
  injectDoudianBridge,
  findAndInject,
  waitBridgeReady,
  INJECT_READY_TIMEOUT_MS,
};
