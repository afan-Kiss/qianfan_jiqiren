const MAX_RECENT_LOGS = 1000;

class RuntimeState {
  constructor() {
    this.supervisorStatus = 'idle';
    this.workers = new Map();
    this.recentLogs = [];
  }

  ensureWorker(workerName) {
    if (!this.workers.has(workerName)) {
      this.workers.set(workerName, {
        name: workerName,
        status: 'registered',
        pid: null,
        startTime: null,
        lastHeartbeatAt: null,
        restartCount: 0,
        lastError: '',
      });
    }
    return this.workers.get(workerName);
  }

  setSupervisorStatus(status) {
    this.supervisorStatus = status;
  }

  setWorkerStatus(workerName, patch = {}) {
    const worker = this.ensureWorker(workerName);
    Object.assign(worker, patch);
    this.workers.set(workerName, worker);
    return worker;
  }

  appendLog(log) {
    this.recentLogs.push(log);
    if (this.recentLogs.length > MAX_RECENT_LOGS) {
      this.recentLogs.splice(0, this.recentLogs.length - MAX_RECENT_LOGS);
    }
    return log;
  }

  getSnapshot() {
    return {
      supervisorStatus: this.supervisorStatus,
      workers: [...this.workers.values()].map((w) => ({ ...w })),
      recentLogs: this.recentLogs.slice(-MAX_RECENT_LOGS),
    };
  }
}

module.exports = {
  RuntimeState,
};
