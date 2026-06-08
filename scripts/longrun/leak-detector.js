const fs = require('fs');
const path = require('path');

function getActiveHandlesCount() {
  if (typeof process._getActiveHandles === 'function') {
    return process._getActiveHandles().length;
  }
  return 0;
}

function getActiveRequestsCount() {
  if (typeof process._getActiveRequests === 'function') {
    return process._getActiveRequests().length;
  }
  return 0;
}

function dirSizeBytes(dir) {
  if (!dir || !fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

function countFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countFiles(full);
    else count += 1;
  }
  return count;
}

class LeakDetector {
  constructor(options = {}) {
    this.strict = options.strict === true;
    this.maxMemoryGrowthMB = Number(options.maxMemoryGrowthMB || 150);
    this.maxHandleGrowth = Number(options.maxHandleGrowth || 20);
    this.maxDirSizeMB = Number(options.maxDirSizeMB || 200);
    this.start = null;
    this.end = null;
  }

  snapshotStart() {
    this.start = {
      rssMB: process.memoryUsage().rss / (1024 * 1024),
      heapMB: process.memoryUsage().heapUsed / (1024 * 1024),
      handles: getActiveHandlesCount(),
      requests: getActiveRequestsCount(),
      time: Date.now(),
    };
    return this.start;
  }

  snapshotEnd(dirs = {}) {
    this.end = {
      rssMB: process.memoryUsage().rss / (1024 * 1024),
      heapMB: process.memoryUsage().heapUsed / (1024 * 1024),
      handles: getActiveHandlesCount(),
      requests: getActiveRequestsCount(),
      logsBytes: dirSizeBytes(dirs.logsDir),
      dataBytes: dirSizeBytes(dirs.dataDir),
      logFiles: countFiles(dirs.logsDir),
      dataFiles: countFiles(dirs.dataDir),
      time: Date.now(),
    };
    return this.end;
  }

  evaluate(metrics) {
    const warnings = [];
    const failures = [];
    if (!this.start || !this.end) return { warnings, failures };

    const memoryGrowth = this.end.rssMB - this.start.rssMB;
    const handleGrowth = this.end.handles - this.start.handles;
    metrics.setHandles(this.start.handles, this.end.handles);
    metrics.updateMemory();

    if (memoryGrowth > this.maxMemoryGrowthMB) {
      const msg = `memory growth ${memoryGrowth.toFixed(2)}MB exceeds ${this.maxMemoryGrowthMB}MB`;
      if (this.strict) failures.push(msg);
      else warnings.push(msg);
    }
    if (handleGrowth > this.maxHandleGrowth) {
      const msg = `active handles growth ${handleGrowth} exceeds ${this.maxHandleGrowth}`;
      if (this.strict) failures.push(msg);
      else warnings.push(msg);
    }
    const dataSizeMB = this.end.dataBytes / (1024 * 1024);
    if (dataSizeMB > this.maxDirSizeMB) {
      const msg = `data dir size ${dataSizeMB.toFixed(2)}MB exceeds ${this.maxDirSizeMB}MB`;
      if (this.strict) failures.push(msg);
      else warnings.push(msg);
    }
    return { warnings, failures, memoryGrowth, handleGrowth, dataSizeMB };
  }
}

module.exports = {
  LeakDetector,
  getActiveHandlesCount,
  getActiveRequestsCount,
  dirSizeBytes,
  countFiles,
};
