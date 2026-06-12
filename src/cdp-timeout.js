/**
 * CDP 调用统一超时封装
 */
const { println } = require('./utils');

const CDP_EVAL_DEFAULT_MS = 8000;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label || 'operation'} timeout`)), ms);
    }),
  ]);
}

async function safeCloseCdp(client, shopTitle, reason, timeoutMs = 5000) {
  if (!client) return false;
  try {
    await withTimeout(client.close(), timeoutMs, `CDP close ${shopTitle || 'unknown'}`);
    return true;
  } catch (err) {
    println(
      `[千帆] CDP 关闭超时/失败：${shopTitle || 'unknown'} reason=${reason} ${err.message || err}`
    );
    return false;
  }
}

async function cdpRuntimeEvaluate(Runtime, params, timeoutMs = CDP_EVAL_DEFAULT_MS) {
  if (!Runtime?.evaluate) throw new Error('Runtime.evaluate unavailable');
  return withTimeout(Runtime.evaluate(params), timeoutMs, 'Runtime.evaluate');
}

async function cdpNetworkEnable(Network, timeoutMs = CDP_EVAL_DEFAULT_MS) {
  return withTimeout(Network.enable(), timeoutMs, 'Network.enable');
}

async function cdpNetworkDisable(Network, timeoutMs = CDP_EVAL_DEFAULT_MS) {
  return withTimeout(Network.disable(), timeoutMs, 'Network.disable');
}

async function cdpPageEnable(Page, timeoutMs = CDP_EVAL_DEFAULT_MS) {
  if (!Page?.enable) return false;
  return withTimeout(Page.enable(), timeoutMs, 'Page.enable');
}

async function cdpAddScriptToEvaluateOnNewDocument(Page, source, timeoutMs = CDP_EVAL_DEFAULT_MS) {
  if (!Page?.addScriptToEvaluateOnNewDocument) return false;
  return withTimeout(
    Page.addScriptToEvaluateOnNewDocument({ source }),
    timeoutMs,
    'Page.addScriptToEvaluateOnNewDocument'
  );
}

async function cdpGetResponseBody(Network, requestId, timeoutMs = CDP_EVAL_DEFAULT_MS) {
  return withTimeout(
    Network.getResponseBody({ requestId }),
    timeoutMs,
    'Network.getResponseBody'
  );
}

async function cdpNetworkSendWebSocketFrame(Network, params, timeoutMs = CDP_EVAL_DEFAULT_MS) {
  if (!Network?.sendWebSocketFrame) throw new Error('Network.sendWebSocketFrame unavailable');
  return withTimeout(Network.sendWebSocketFrame(params), timeoutMs, 'Network.sendWebSocketFrame');
}

module.exports = {
  withTimeout,
  safeCloseCdp,
  cdpRuntimeEvaluate,
  cdpNetworkEnable,
  cdpNetworkDisable,
  cdpPageEnable,
  cdpAddScriptToEvaluateOnNewDocument,
  cdpGetResponseBody,
  cdpNetworkSendWebSocketFrame,
  CDP_EVAL_DEFAULT_MS,
};
