const { println } = require('../../shared/logger');
const { DOUDIAN_EVENTS } = require('./doudian-types');
const { normalizeAftersaleEvent } = require('./doudian-normalizer');
const { insertAftersale } = require('./doudian-data-store');

const NEED_HANDLE_KEYWORDS = [
  '退款申请',
  '退货退款',
  '仅退款',
  '买家补充说明',
  '平台介入',
  '待商家处理',
  '即将超时',
];

class DoudianAftersaleListener {
  constructor(options = {}) {
    this.wsServer = options.wsServer;
    this.handlers = {
      onAftersale: options.onAftersale || null,
      onUiNotify: options.onUiNotify || null,
    };
    this.ready = false;
    this.unsubscribes = [];
  }

  start() {
    if (!this.wsServer) throw new Error('wsServer required');
    if (this.ready) return { ok: true, already: true };

    const types = [
      DOUDIAN_EVENTS.AFTERSALE_CREATED,
      DOUDIAN_EVENTS.AFTERSALE_UPDATED,
      DOUDIAN_EVENTS.AFTERSALE_MESSAGE,
      DOUDIAN_EVENTS.AFTERSALE_NEED_HANDLE,
    ];

    for (const type of types) {
      const off = this.wsServer.on(type, (envelope) => {
        this.handleAftersaleEvent(envelope);
      });
      this.unsubscribes.push(off);
    }

    this.ready = true;
    println('售后监听已就绪');
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

  isNeedHandle(record) {
    const text = `${record.status || ''} ${record.reason || ''} ${record.text || ''}`;
    return NEED_HANDLE_KEYWORDS.some((k) => text.includes(k));
  }

  handleAftersaleEvent(envelope) {
    const normalized = normalizeAftersaleEvent(envelope);
    if (!normalized.aftersaleId && !normalized.text && !normalized.status) {
      println('售后事件字段不足，已记录雏形日志');
    }

    insertAftersale(normalized);
    println(`收到售后事件 type=${normalized.type || envelope.type} aftersaleId=${normalized.aftersaleId || ''}`);

    const needHandle = envelope.type === DOUDIAN_EVENTS.AFTERSALE_NEED_HANDLE || this.isNeedHandle(normalized);
    const output = {
      type: DOUDIAN_EVENTS.AFTERSALE_NEED_HANDLE,
      ...normalized,
      needHandle,
    };

    if (typeof this.handlers.onUiNotify === 'function') {
      this.handlers.onUiNotify({ type: 'aftersale', record: output });
    }
    if (typeof this.handlers.onAftersale === 'function') {
      this.handlers.onAftersale(output);
    }
  }
}

module.exports = {
  DoudianAftersaleListener,
  NEED_HANDLE_KEYWORDS,
};
