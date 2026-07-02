/**
 * 纯协议旁路 — 经 live bridge 的 page_ws 中继发送 / 监听（不改动主 sendQianfanTextReply 路径）
 */
const { parseSendAckFrame } = require('./qianfan-protocol-client');
const { assertProtocolImSendAllowed } = require('./qianfan-protocol-send-guard');

const DEFAULT_ACK_TIMEOUT_MS = 8000;

function getBridgeModule() {
  return require('../qianfan-ws-bridge');
}

function findLiveBridge(shopTitle) {
  const { findBridgeByShopTitle, isBridgeCdpReady } = getBridgeModule();
  const bridge = findBridgeByShopTitle(shopTitle);
  if (!bridge) return { ok: false, error: 'bridge_not_found', bridge: null };
  if (!isBridgeCdpReady(bridge)) return { ok: false, error: 'cdp_not_ready', bridge };
  return { ok: true, bridge };
}

function registerBridgeFrameListener(shopTitle, handler) {
  const pick = findLiveBridge(shopTitle);
  if (!pick.ok || !pick.bridge?.frameListeners) {
    return () => {};
  }
  pick.bridge.frameListeners.add(handler);
  return () => {
    try {
      pick.bridge.frameListeners.delete(handler);
    } catch {
      // ignore
    }
  };
}

function registerBridgeBuyerListener(shopTitle, handler) {
  const { registerBuyerMessageHandler } = getBridgeModule();
  registerBuyerMessageHandler(shopTitle, handler);
  return () => {};
}

async function waitRelayAck(bridge, ctx, sentAfterMs, timeoutMs = DEFAULT_ACK_TIMEOUT_MS) {
  let hit = null;
  let errHit = null;

  const onFrame = (parsed) => {
    const ack = parseSendAckFrame(parsed, ctx);
    if (!ack) return;
    if (ack.error) {
      errHit = ack.error;
      return;
    }
    hit = { ...ack, ackSource: 'bridge_relay' };
  };

  bridge.frameListeners.add(onFrame);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (hit) return hit;
      if (errHit) throw errHit;
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error('bridge relay ACK 超时');
  } finally {
    bridge.frameListeners.delete(onFrame);
  }
}

async function relaySendPayload(shopTitle, payload, options = {}) {
  const buyerNick = String(options.buyerNick || '').trim();
  if (options.reallySend !== false) {
    assertProtocolImSendAllowed(buyerNick, 'protocol_bridge_relay');
  }

  const { tryPageWsSend, probePageImpaasWs } = getBridgeModule();
  const pick = findLiveBridge(shopTitle);
  if (!pick.ok) return { ok: false, error: pick.error };

  const bridge = pick.bridge;
  const appCid = String(options.appCid || payload?.body?.appCid || '').trim();
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const ctx = {
    traceId: options.traceId || payload?.header?.traceId || '',
    sMid: options.sMid || payload?.header?.sMid || '',
    uuid: options.uuid || payload?.body?.uuid || '',
    appCid,
    text: options.text || payload?.body?.contentInfo?.content || '',
  };

  const probed = await probePageImpaasWs(bridge);
  if (!probed.ok) {
    return { ok: false, error: 'no_page_ws', probe: probed };
  }

  const sentAfterMs = Date.now();
  const sent = await tryPageWsSend(bridge, payloadStr, appCid);
  if (!sent.ok) {
    return { ok: false, error: sent.reason || 'page_ws_send_failed', sent };
  }

  if (options.waitAck === false) {
    return { ok: true, sent: true, method: sent.method || 'page_ws', relay: true };
  }

  try {
    const ack = await waitRelayAck(bridge, ctx, sentAfterMs, options.ackTimeoutMs || DEFAULT_ACK_TIMEOUT_MS);
    return {
      ok: true,
      sent: true,
      method: sent.method || 'page_ws',
      relay: true,
      ack,
      traceId: ctx.traceId,
      sMid: ctx.sMid,
      uuid: ctx.uuid,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message || String(err),
      sent: true,
      method: sent.method || 'page_ws',
      relay: true,
      traceId: ctx.traceId,
    };
  }
}

function startBridgeListen(shopTitle, { onFrame, onBuyerMessage } = {}) {
  const unsubs = [];
  if (typeof onFrame === 'function') {
    unsubs.push(
      registerBridgeFrameListener(shopTitle, (parsed) => {
        onFrame(parsed);
      })
    );
  }
  if (typeof onBuyerMessage === 'function') {
    unsubs.push(
      registerBridgeBuyerListener(shopTitle, (messages, parsed) => {
        for (const msg of messages || []) onBuyerMessage(msg, parsed);
      })
    );
  }
  return () => {
    for (const fn of unsubs) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  };
}

function getBridgeListenStatus(shopTitle) {
  const pick = findLiveBridge(shopTitle);
  return {
    ok: pick.ok,
    error: pick.error || '',
    cdpReady: Boolean(pick.bridge && pick.ok),
    lastWsFrameAt: pick.bridge?.lastWsFrameAt || 0,
    connectedAt: pick.bridge?.connectedAt || 0,
  };
}

module.exports = {
  findLiveBridge,
  registerBridgeFrameListener,
  registerBridgeBuyerListener,
  relaySendPayload,
  startBridgeListen,
  getBridgeListenStatus,
};
