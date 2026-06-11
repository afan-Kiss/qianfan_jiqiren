const { println } = require('./logger');

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

async function safeCloseCdp(client, label, reason, timeoutMs = 5000) {
  if (!client) return false;
  try {
    await withTimeout(client.close(), timeoutMs, `CDP close ${label || 'unknown'}`);
    return true;
  } catch (err) {
    println(`CDP 关闭失败：${label || 'unknown'} reason=${reason} ${err.message || err}`);
    return false;
  }
}

async function cdpRuntimeEvaluate(Runtime, params, timeoutMs = CDP_EVAL_DEFAULT_MS) {
  if (!Runtime?.evaluate) throw new Error('Runtime.evaluate unavailable');
  return withTimeout(Runtime.evaluate(params), timeoutMs, 'Runtime.evaluate');
}

async function cdpAddScriptToEvaluateOnNewDocument(Page, source, timeoutMs = CDP_EVAL_DEFAULT_MS) {
  if (!Page?.addScriptToEvaluateOnNewDocument) return false;
  return withTimeout(
    Page.addScriptToEvaluateOnNewDocument({ source }),
    timeoutMs,
    'Page.addScriptToEvaluateOnNewDocument'
  );
}

module.exports = {
  withTimeout,
  safeCloseCdp,
  cdpRuntimeEvaluate,
  cdpAddScriptToEvaluateOnNewDocument,
  CDP_EVAL_DEFAULT_MS,
};
