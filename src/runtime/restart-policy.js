class RestartPolicy {
  constructor(options = {}) {
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 60000;
    this.maxRestartsInWindow = options.maxRestartsInWindow ?? 10;
    this.windowMs = options.windowMs ?? 10 * 60 * 1000;
    this.states = new Map();
  }

  ensure(workerName) {
    if (!this.states.has(workerName)) {
      this.states.set(workerName, {
        restarts: [],
        manualResetAt: 0,
      });
    }
    return this.states.get(workerName);
  }

  pruneRestarts(state) {
    const cutoff = Date.now() - this.windowMs;
    state.restarts = state.restarts.filter((t) => t >= cutoff);
  }

  canRestart(workerName) {
    const state = this.ensure(workerName);
    this.pruneRestarts(state);
    return state.restarts.length < this.maxRestartsInWindow;
  }

  recordRestart(workerName) {
    const state = this.ensure(workerName);
    this.pruneRestarts(state);
    state.restarts.push(Date.now());
    return this.getState(workerName);
  }

  getDelayMs(workerName) {
    const state = this.ensure(workerName);
    this.pruneRestarts(state);
    const attempt = Math.max(state.restarts.length, 1);
    const delay = this.baseDelayMs * 2 ** (attempt - 1);
    return Math.min(delay, this.maxDelayMs);
  }

  reset(workerName) {
    const state = this.ensure(workerName);
    state.restarts = [];
    state.manualResetAt = Date.now();
    return this.getState(workerName);
  }

  getState(workerName) {
    const state = this.ensure(workerName);
    this.pruneRestarts(state);
    return {
      restartCount: state.restarts.length,
      canRestart: state.restarts.length < this.maxRestartsInWindow,
      nextDelayMs: this.getDelayMs(workerName),
      failed: state.restarts.length >= this.maxRestartsInWindow,
    };
  }
}

module.exports = {
  RestartPolicy,
};
