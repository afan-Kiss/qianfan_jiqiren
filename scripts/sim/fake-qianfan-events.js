const { ok } = require('../../src/adapters/adapter-result');

let buyerHandler = null;

function startFakeBuyerListener({ onBuyerMessage } = {}) {
  buyerHandler = onBuyerMessage;
  return ok({ listenerHandle: { stop: async () => ok({ stopped: true }) } });
}

function injectBuyerMessage(message, options = {}) {
  if (typeof buyerHandler !== 'function') {
    throw new Error('fake buyer listener not started');
  }
  buyerHandler(message, options);
}

function stopFakeBuyerListener() {
  buyerHandler = null;
  return ok({ stopped: true });
}

module.exports = {
  startFakeBuyerListener,
  injectBuyerMessage,
  stopFakeBuyerListener,
};
