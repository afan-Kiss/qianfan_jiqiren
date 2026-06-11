const { println } = require('../../shared/logger');
const { DOUDIAN_EVENTS } = require('./doudian-types');
const { normalizeInboundMessage } = require('./doudian-normalizer');
const { DoudianDedupe } = require('./doudian-dedupe');
const {
  insertMessage,
  getConversationTakeoverStatus,
  hasRepliedMessage,
} = require('./doudian-data-store');

class DoudianMessageListener {
  constructor(options = {}) {
    this.wsServer = options.wsServer;
    this.dedupe = options.dedupe || new DoudianDedupe();
    this.handlers = {
      onInboundMessage: options.onInboundMessage || null,
      onUiNotify: options.onUiNotify || null,
    };
    this.ready = false;
    this.unsubscribes = [];
    this.repliedMessages = new Set();
  }

  start() {
    if (!this.wsServer) throw new Error('wsServer required');
    if (this.ready) return { ok: true, already: true };

    const offInbound = this.wsServer.on(DOUDIAN_EVENTS.MESSAGE_INBOUND, (envelope) => {
      this.handleInbound(envelope);
    });
    const offOutbound = this.wsServer.on(DOUDIAN_EVENTS.MESSAGE_OUTBOUND, (envelope) => {
      this.handleOutbound(envelope);
    });

    this.unsubscribes.push(offInbound, offOutbound);
    this.ready = true;
    println('消息监听已就绪');
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

  handleInbound(envelope) {
    const normalized = normalizeInboundMessage(envelope);
    if (normalized.direction !== 'inbound') return;

    if (this.dedupe.isDuplicate(normalized)) {
      println(`消息去重跳过 messageId=${normalized.messageId || ''} conversationId=${normalized.conversationId || ''}`);
      return;
    }

    const merged = this.dedupe.shouldMerge(normalized);
    if (merged) {
      println(`消息合并窗口内 conversationId=${normalized.conversationId || ''}`);
      return;
    }

    const saved = insertMessage(normalized);
    println(`收到买家消息 conversationId=${normalized.conversationId || ''} text=${String(normalized.text || '').slice(0, 60)}`);

    const takeover = getConversationTakeoverStatus(normalized.conversationId);
    const payloadForAi = {
      ...normalized,
      dbId: saved.id,
      takeoverStatus: takeover,
      shouldAutoReply: takeover !== 'manual' && !hasRepliedMessage(normalized.messageId),
    };

    if (typeof this.handlers.onUiNotify === 'function') {
      this.handlers.onUiNotify({
        type: 'inbound_message',
        message: payloadForAi,
      });
    }

    if (typeof this.handlers.onInboundMessage === 'function') {
      this.handlers.onInboundMessage(payloadForAi);
    }
  }

  handleOutbound(envelope) {
    const normalized = normalizeInboundMessage({ ...envelope, payload: { ...envelope.payload, direction: 'outbound' } });
    normalized.direction = 'outbound';
    insertMessage(normalized);
    if (normalized.messageId) this.repliedMessages.add(normalized.messageId);
  }

  markReplied(messageId) {
    if (messageId) this.repliedMessages.add(messageId);
  }

  isReplied(messageId) {
    return this.repliedMessages.has(messageId) || hasRepliedMessage(messageId);
  }
}

module.exports = {
  DoudianMessageListener,
};
