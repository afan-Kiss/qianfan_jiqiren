const { START_ORDER } = require('../../src/runtime/worker-registry');
const { writeState, resetState } = require('../sim/sim-chaos-state');
const { sleep } = require('../sim/fake-runtime-harness');

function createSeededRandom(seed) {
  let state = Number(seed) >>> 0 || 1;
  return function next() {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class ChaosMonkey {
  constructor(options = {}) {
    this.seed = Number(options.seed || 2002);
    this.rand = createSeededRandom(this.seed);
    this.workerNames = options.workerNames || START_ORDER;
    this.metrics = options.metrics || null;
  }

  pickWorker() {
    const idx = Math.floor(this.rand() * this.workerNames.length);
    return this.workerNames[idx];
  }

  async maybeCrash(harness, profile = {}) {
    if (this.rand() >= Number(profile.crashRate || 0)) return false;
    const worker = this.pickWorker();
    harness.supervisor.markCrashNextStart(worker);
    await harness.supervisor.restartWorker(worker, 'chaos-crash', { manual: true });
    if (this.metrics) this.metrics.recordWorkerCrash(worker);
    return true;
  }

  async maybeStopHeartbeat(harness, profile = {}) {
    if (this.rand() >= Number(profile.timeoutRate || 0)) return false;
    const worker = this.pickWorker();
    harness.stopWorkerHeartbeat(worker);
    if (this.metrics) this.metrics.recordWatchdogTimeout(worker);
    await sleep(600);
    return true;
  }

  async maybePersistenceDelay(profile = {}) {
    if (this.rand() >= Number(profile.persistenceDelayRate || 0)) {
      writeState({ persistenceDelayMs: 0, requestTimeoutMs: 0 });
      return false;
    }
    writeState({ persistenceDelayMs: 800, requestTimeoutMs: 300 });
    if (this.metrics) this.metrics.recordPersistenceTimeout();
    return true;
  }

  async maybeQianfanFail(profile = {}) {
    const fail = this.rand() < Number(profile.qianfanFailRate || 0);
    writeState({ qianfanSendFail: fail });
    return fail;
  }

  async maybeWechatNotifyFail(profile = {}) {
    const fail = this.rand() < Number(profile.wechatNotifyFailRate || 0);
    writeState({ wechatNotifyFail: fail });
    return fail;
  }

  async maybeDuplicateCallback(harness, event, traceId) {
    if (!event || event.type !== 'reply') return false;
    if (typeof harness.injectWechatReply === 'function' && harness.metrics) {
      await harness.injectWechatReply({ ...event, duplicate: true }, traceId);
    } else {
      await harness.injectWechatReply(event, traceId);
      if (this.metrics) this.metrics.recordWechatReplyDuplicate();
    }
    return true;
  }

  async maybeRendererRefresh(harness) {
    if (this.metrics) this.metrics.recordRendererRefresh();
    return harness.simulateRendererRefresh();
  }

  async maybeStopStart(harness, profile = {}) {
    if (this.rand() >= Number(profile.crashRate || 0) * 0.5) return false;
    await harness.stop();
    await harness.start();
    if (this.metrics) this.metrics.recordRuntimeRestart();
    return true;
  }

  reset() {
    resetState();
  }
}

module.exports = {
  ChaosMonkey,
};
