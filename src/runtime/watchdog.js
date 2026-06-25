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
    this.externalHealthProbe = null;
    this.externalHealthProbeIntervalMs = options.externalHealthProbeIntervalMs ?? 15000;
    this.lastExternalHealthProbeAt = 0;
    this.externalHealthProbeInFlight = false;
  }

  register(workerName, options = {}) {
    this.workers.set(workerName, {
      workerName,
      lastBeatAt: Date.now(),
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? this.heartbeatTimeoutMs,
      timeoutPending: false,
    });
  }

  setExternalHealthProbe(probeFn, options = {}) {
    this.externalHealthProbe = typeof probeFn === 'function' ? probeFn : null;
    this.externalHealthProbeIntervalMs = options.intervalMs ?? this.externalHealthProbeIntervalMs;
    this.lastExternalHealthProbeAt = 0;
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
    this.externalHealthProbeInFlight = false;
  }

  async runExternalHealthProbe() {
    if (!this.externalHealthProbe || this.externalHealthProbeInFlight || this.stopped) return;
    const now = Date.now();
    if (now - this.lastExternalHealthProbeAt < this.externalHealthProbeIntervalMs) return;
    this.lastExternalHealthProbeAt = now;
    this.externalHealthProbeInFlight = true;
    try {
      const result = await this.externalHealthProbe();
      if (!result || result.skipped) return;
      if (result.wrongLogin) {
        this.emit('wxbot-wrong-login', result);
        return;
      }
      if (!result.healthy) {
        this.emit('wxbot-unhealthy', result);
      } else if (result.recoveredFromUnhealthy) {
        this.emit('wxbot-recovered', result);
      }
    } catch (err) {
      this.emit('wxbot-unhealthy', {
        healthy: false,
        reason: err.message || String(err),
        error: err,
      });
    } finally {
      this.externalHealthProbeInFlight = false;
    }
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
    void this.runExternalHealthProbe();
  }

  dispose() {
    this.stop();
    this.removeAllListeners();
  }
}

module.exports = {
  Watchdog,
};
