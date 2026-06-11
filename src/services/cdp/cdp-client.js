const WebSocket = require('ws');
const { bridgeLog } = require('../../shared/bridge-log');

class CdpClient {
  constructor(options = {}) {
    this.wsUrl = options.wsUrl || '';
    this.targetId = options.targetId || '';
    this.label = options.label || this.targetId || 'cdp';
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Set();
    this.closed = false;
    this.reconnect = Boolean(options.reconnect);
    this.connectTimeoutMs = Number(options.connectTimeoutMs || 10000);
    this.commandTimeoutMs = Number(options.commandTimeoutMs || 15000);
  }

  on(eventHandler) {
    this.handlers.add(eventHandler);
    return () => this.handlers.delete(eventHandler);
  }

  emit(event) {
    for (const fn of this.handlers) {
      try {
        fn(event);
      } catch (err) {
        bridgeLog('[BRIDGE_ERROR]', 'CDP event handler failed', String(err.message || err));
      }
    }
  }

  async connect() {
    if (!this.wsUrl) throw new Error('missing webSocketDebuggerUrl');
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return true;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('CDP connect timeout'));
      }, this.connectTimeoutMs);

      try {
        this.ws = new WebSocket(this.wsUrl);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }

      this.ws.on('open', () => {
        clearTimeout(timer);
        this.closed = false;
        bridgeLog('[CDP_CONNECT]', `已连接 target=${this.label}`);
        resolve(true);
      });

      this.ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej, timer: t } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(t);
          if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          else res(msg.result);
          return;
        }
        if (msg.method) {
          this.emit({ type: 'event', method: msg.method, params: msg.params || {}, sessionId: msg.sessionId });
        }
      });

      this.ws.on('close', () => {
        this.closed = true;
        bridgeLog('[CDP_CONNECT]', `连接断开 target=${this.label}`);
        this.emit({ type: 'close' });
      });

      this.ws.on('error', (err) => {
        bridgeLog('[BRIDGE_ERROR]', `CDP socket error target=${this.label}`, String(err.message || err));
        this.emit({ type: 'error', error: err });
      });
    });
  }

  async send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, this.commandTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async close() {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('client closed'));
    }
    this.pending.clear();
  }
}

module.exports = {
  CdpClient,
};
