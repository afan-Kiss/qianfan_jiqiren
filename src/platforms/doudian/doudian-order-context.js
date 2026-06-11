const { println } = require('../../shared/logger');
const { DOUDIAN_EVENTS } = require('./doudian-types');
const { normalizeOrderContext } = require('./doudian-normalizer');

class DoudianOrderContext {
  constructor(options = {}) {
    this.wsServer = options.wsServer;
    this.cache = new Map();
    this.handlers = {
      onOrderContext: options.onOrderContext || null,
    };
    this.ready = false;
    this.unsubscribes = [];
  }

  start() {
    if (!this.wsServer) throw new Error('wsServer required');
    if (this.ready) return { ok: true, already: true };

    const off = this.wsServer.on(DOUDIAN_EVENTS.ORDER_CONTEXT, (envelope) => {
      this.handleOrderContext(envelope);
    });
    this.unsubscribes.push(off);
    this.ready = true;
    println('订单上下文监听已就绪');
    return { ok: true };
  }

  stop() {
    for (const off of this.unsubscribes) {
      try {
        off && off();
      } catch {
        // ignore
      }
    }
    this.unsubscribes = [];
    this.ready = false;
  }

  handleOrderContext(envelope) {
    const normalized = normalizeOrderContext(envelope);
    const key = normalized.orderId || normalized.conversationId || `ctx-${Date.now()}`;
    this.cache.set(key, normalized);

    if (normalized.orderId) {
      println(`订单上下文更新 orderId=${normalized.orderId} status=${normalized.orderStatus || ''}`);
    }

    if (typeof this.handlers.onOrderContext === 'function') {
      this.handlers.onOrderContext(normalized);
    }
  }

  getByOrderId(orderId) {
    return this.cache.get(orderId) || null;
  }

  getByConversationId(conversationId) {
    for (const ctx of this.cache.values()) {
      if (ctx.conversationId === conversationId) return ctx;
    }
    return null;
  }

  getContextForReply({ conversationId, orderId } = {}) {
    if (orderId && this.cache.has(orderId)) return this.cache.get(orderId);
    return this.getByConversationId(conversationId);
  }
}

module.exports = {
  DoudianOrderContext,
};
