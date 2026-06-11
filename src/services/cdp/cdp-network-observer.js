const { bridgeLog } = require('../../shared/bridge-log');

function attachNetworkObserver(client, router, targetMeta = {}) {
  let enabled = false;

  async function enable() {
    if (enabled) return true;
    try {
      await client.send('Network.enable');
      enabled = true;
      bridgeLog('[WS_HOOK]', `Network.enable ok target=${targetMeta.targetId || ''}`);
      return true;
    } catch (err) {
      bridgeLog('[BRIDGE_ERROR]', 'Network.enable failed', String(err.message || err));
      return false;
    }
  }

  const off = client.on((event) => {
    if (event.type !== 'event') return;
    const method = event.method;
    const p = event.params || {};

    if (method === 'Network.webSocketCreated') {
      router.route({
        source: 'cdp-network',
        kind: 'ws_created',
        direction: 'meta',
        targetId: targetMeta.targetId,
        requestId: p.requestId,
        url: p.url || '',
        pageTitle: targetMeta.pageTitle,
        pageUrl: targetMeta.pageUrl,
        shopId: targetMeta.shopId,
        shopName: targetMeta.shopName,
        timestamp: Date.now(),
      });
      return;
    }

    if (method === 'Network.webSocketClosed') {
      router.route({
        source: 'cdp-network',
        kind: 'ws_closed',
        direction: 'meta',
        targetId: targetMeta.targetId,
        requestId: p.requestId,
        timestamp: Date.now(),
      });
      return;
    }

    if (method === 'Network.webSocketFrameReceived') {
      const frame = p.response || {};
      router.route({
        source: 'cdp-network',
        kind: 'ws_frame',
        direction: 'in',
        targetId: targetMeta.targetId,
        requestId: p.requestId,
        payloadText: frame.payloadData || '',
        opcode: frame.opcode,
        mask: frame.mask,
        pageTitle: targetMeta.pageTitle,
        pageUrl: targetMeta.pageUrl,
        shopId: targetMeta.shopId,
        shopName: targetMeta.shopName,
        timestamp: Date.now(),
      });
      return;
    }

    if (method === 'Network.webSocketFrameSent') {
      const frame = p.response || {};
      router.route({
        source: 'cdp-network',
        kind: 'ws_frame',
        direction: 'out',
        targetId: targetMeta.targetId,
        requestId: p.requestId,
        payloadText: frame.payloadData || '',
        opcode: frame.opcode,
        mask: frame.mask,
        pageTitle: targetMeta.pageTitle,
        pageUrl: targetMeta.pageUrl,
        shopId: targetMeta.shopId,
        shopName: targetMeta.shopName,
        timestamp: Date.now(),
      });
      return;
    }

    if (method === 'Network.webSocketFrameError') {
      router.route({
        source: 'cdp-network',
        kind: 'ws_error',
        direction: 'meta',
        targetId: targetMeta.targetId,
        requestId: p.requestId,
        payloadText: p.errorMessage || '',
        timestamp: Date.now(),
      });
    }
  });

  return {
    enable,
    dispose: () => off(),
  };
}

module.exports = {
  attachNetworkObserver,
};
