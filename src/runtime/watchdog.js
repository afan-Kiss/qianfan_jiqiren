const { EventEmitter } = require('events');

class Watchdog extends EventEmitter {
  constructor(options = {}) {
    super();
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 20000;
    this.checkIntervalMs = options.checkIntervalMs ?? 5000;
    this.workers = new Map();
    this.timer = null;
    this.stopped = true;
  }

  register(workerName, options = {}) {
    this.workers.set(workerName, {
      workerName,
      lastBeatAt: Date.now(),
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? this.heartbeatTimeoutMs,
      timeoutPending: false,
    });
  }

  beat(workerName) {
    const entry = this.workers.get(workerName);
    if (!entry) {
      this.register(workerName);
    }
    const current = this.workers.get(workerName);
    current.lastBeatAt = Date.now();
    current.timeoutPending = false;
    this.workers.set(workerName, current);
  }

  unregister(workerName) {
    this.workers.delete(workerName);
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.check(), this.checkIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.workers.clear();
  }

  check() {
    if (this.stopped || !this.timer) return;
    const now = Date.now();
    for (const [workerName, entry] of this.workers.entries()) {
      if (entry.timeoutPending) continue;
      const timeoutMs = entry.heartbeatTimeoutMs ?? this.heartbeatTimeoutMs;
      if (now - entry.lastBeatAt > timeoutMs) {
        entry.timeoutPending = true;
        this.workers.set(workerName, entry);
        this.emit('timeout', { workerName, lastBeatAt: entry.lastBeatAt, timeoutMs });
      }
    }
  }

  dispose() {
    this.stop();
    this.removeAllListeners();
  }
}

module.exports = {
  Watchdog,
};
