const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { FakeRuntimeHarness, sleep, readJson, cleanupTestDir } = require('../sim/fake-runtime-harness');
const { resetState, writeState } = require('../sim/sim-chaos-state');
const { VirtualClock } = require('./virtual-clock');
const { EventGenerator } = require('./event-generator');
const { ChaosMonkey } = require('./chaos-monkey');
const { LongrunMetrics, normalizeReplyText } = require('./longrun-metrics');
const { LeakDetector, countFiles } = require('./leak-detector');
const { writeReportBundle } = require('./longrun-report');
const { START_ORDER } = require('../../src/runtime/worker-registry');
const { hashText } = require('../../src/runtime/idempotency-keys');

class LongrunHarness {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.resolve(__dirname, '..', '..');
    this.runId = options.runId || `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    this.testDataDir = options.testDataDir || path.join(this.rootDir, 'data', 'test-longrun', this.runId);
    this.reportDir = options.reportDir || path.join(this.rootDir, 'reports', 'longrun', this.runId);
    this.clock = options.clock || new VirtualClock();
    this.metrics = options.metrics || new LongrunMetrics();
    this.leakDetector = options.leakDetector || new LeakDetector(options.leakOptions || {});
    this.seed = Number(options.seed || 1001);
    this.generator = new EventGenerator({
      seed: this.seed,
      clock: this.clock,
      runId: this.runId,
    });
    this.chaos = new ChaosMonkey({ seed: this.seed + 17, metrics: this.metrics });
    this.pendingMap = new Map();
    this.errors = [];
    this.injectDelayMs = Number(options.injectDelayMs ?? 40);
    this.options = options;
    this.fake = null;
  }

  async start() {
    resetState();
    this.fake = new FakeRuntimeHarness({
      rootDir: this.rootDir,
      runId: this.runId,
      testDataDir: this.testDataDir,
      mergeMs: 0,
      injectDelayMs: this.injectDelayMs,
      startWorkerDelayMs: this.options.startWorkerDelayMs ?? 60,
      readyTimeoutMs: this.options.readyTimeoutMs ?? 12000,
      watchdog: this.options.watchdog || {
        heartbeatIntervalMs: 100,
        heartbeatTimeoutMs: 500,
        checkIntervalMs: 100,
      },
      restartPolicy: this.options.restartPolicy || { baseDelayMs: 200, maxDelayMs: 800 },
      simEnv: {
        QIANFAN_SIM_HEARTBEAT_INTERVAL_MS: '100',
        ...(this.options.simEnv || {}),
      },
      workerExtraEnv: this.options.workerExtraEnv || {},
    });
    this.leakDetector.snapshotStart();
    await this.fake.start();
    return this;
  }

  async stop() {
    if (!this.fake) return;
    await this.fake.stop({ verify: true });
    this.fake = null;
    resetState();
  }

  get supervisor() {
    return this.fake?.supervisor || null;
  }

  async sleep(ms) {
    return sleep(ms);
  }

  simulateRendererRefresh() {
    this.metrics.recordRendererRefresh();
    return true;
  }

  async injectBuyerMessage(event) {
    const duplicate = Boolean(event.duplicate);
    this.metrics.recordBuyerMessage(event, duplicate);
    if (duplicate) return event.traceId;

    const beforeNotify = this.fake.getNotifyCount();
    const traceId = await this.fake.injectBuyerMessage(event.message, { traceId: event.traceId });
    const afterNotify = this.fake.getNotifyCount();
    if (afterNotify > beforeNotify) this.metrics.recordNotification(true);
    else this.metrics.recordNotification(false);
    return traceId;
  }

  async injectWechatReply(event, traceId) {
    const duplicate = Boolean(event.duplicate);
    this.metrics.recordWechatReply(event, duplicate);
    if (duplicate) return event.wxMsgId;

    const processableKey = `${event.replyId}:${hashText(normalizeReplyText(event.text, event.replyId))}`;
    const before = this.fake.getQianfanSendCount();
    const beforeFailReceipt = this.fake.getFailureReceiptCount();
    await this.fake.injectWechatReply(event, traceId || event.traceId);
    await this.fake.waitFor(
      () =>
        this.fake.getQianfanSendCount() > before
        || this.fake.getFailureReceiptCount() > beforeFailReceipt
        || this.fake.readDeadLetters().length > 0,
      1200,
      50,
    );

    const after = this.fake.getQianfanSendCount();
    const failReceipts = this.fake.getFailureReceiptCount();
    if (after > before) {
      this.metrics.recordQianfanSend(true, processableKey);
    } else if (failReceipts > beforeFailReceipt) {
      this.metrics.recordQianfanSend(false, processableKey);
    }

    const successReceipts = this.fake.getSuccessReceiptCount();
    if (successReceipts > this.metrics.successReceiptsSent) {
      this.metrics.recordSuccessReceipt();
    }
    return event.wxMsgId;
  }

  async applyChaos(dayIndex, profile = {}) {
    const hasChaos = ['crashRate', 'timeoutRate', 'persistenceDelayRate', 'qianfanFailRate', 'wechatNotifyFailRate']
      .some((key) => Number(profile[key] || 0) > 0);
    if (!hasChaos) return false;

    writeState({ persistenceDelayMs: 0, requestTimeoutMs: 0, qianfanSendFail: false, wechatNotifyFail: false });
    await this.chaos.maybePersistenceDelay(profile);
    await this.chaos.maybeQianfanFail(profile);
    await this.chaos.maybeWechatNotifyFail(profile);
    await this.chaos.maybeCrash(this.fake, profile);
    await this.chaos.maybeStopHeartbeat(this.fake, profile);
    if (this.chaos.rand() < Number(profile.crashRate || 0) * 0.2) {
      await this.chaos.maybeRendererRefresh(this);
    }
    return true;
  }

  async resolvePendingFromNotify() {
    const pendingList = this.fake.readPending();
    if (pendingList.length) return pendingList[pendingList.length - 1];
    const notify = this.fake.readWechatSent().find((item) => String(item.content || '').includes('【千帆待回复'));
    const match = String(notify?.content || '').match(/#(\d+)/);
    if (!match) return null;
    return { replyId: Number(match[1]), traceId: notify.traceId };
  }

  async processBuyerEvent(event) {
    const traceId = await this.injectBuyerMessage(event);
    await this.fake.waitFor(
      () => this.fake.readPending().length > 0 || this.fake.getNotifyCount() > 0,
      5000,
      40,
    );
    const pending = (await this.resolvePendingFromNotify()) || this.fake.readPending().slice(-1)[0];
    if (pending?.replyId) {
      this.pendingMap.set(event.messageId, {
        replyId: pending.replyId,
        traceId,
        pendingKey: event.messageId,
      });
      this.generator.rememberPending(event.messageId, {
        replyId: pending.replyId,
        traceId,
        pendingKey: event.messageId,
      });
    }
    return traceId;
  }

  async runDay(dayIndex, profile = {}) {
    const events = this.generator.generateDay(dayIndex, profile);
    for (const event of events) {
      if (event.type === 'buyer') {
        await this.processBuyerEvent(event);
        if (this.generator.shouldReply(profile)) {
          const pending = this.generator.getPending(event.messageId);
          if (pending) {
            const reply = this.generator.nextWechatReply(pending, dayIndex);
            await this.injectWechatReply(reply, pending.traceId);
            if (this.generator.shouldDuplicate(profile)) {
              await this.chaos.maybeDuplicateCallback(this, { ...reply, duplicate: true }, pending.traceId);
            }
          }
        }
      }
    }
    await this.applyChaos(dayIndex, profile);
    this.metrics.daysSimulated += 1;
    this.metrics.updateMemory();
    this.syncMetricsFromStore();
    this.assertInvariants(false);
    return true;
  }

  syncMetricsFromStore() {
    this.metrics.recordDeadLetter(this.fake.readDeadLetters().length);

    const failureMap = this.fake.readFailureReceiptMap();
    let actualSent = 0;
    for (const [key, entry] of Object.entries(failureMap)) {
      if (entry?.status === 'sent') {
        actualSent += 1;
        this.metrics.uniqueFailureReceiptKeys.add(key);
      }
    }
    this.metrics.failureReceiptActualSent = actualSent;
    this.metrics.failureReceiptsSent = this.fake.getFailureReceiptCount();

    const notifies = this.fake.getNotifyCount();
    const uniqueBuyerNotifies = this.fake.getUniqueBuyerNotifyCount();
    this.metrics.uniqueBuyerNotifies = uniqueBuyerNotifies;
    this.metrics.notificationsSucceeded = Math.min(
      uniqueBuyerNotifies,
      this.metrics.uniqueBuyerIds.size || uniqueBuyerNotifies,
    );
    this.metrics.qianfanSendSucceeded = this.fake.getQianfanSendCount();

    const attemptCount = this.fake.getQianfanAttemptCount?.() ?? this.fake.getQianfanSendCount();
    this.metrics.setQianfanSendActualAttempts(attemptCount);

    this.metrics.qianfanSendRequestsDeduped = Math.max(
      0,
      this.metrics.qianfanSendRequestsPublished - this.metrics.qianfanSendActualAttempts,
    );
  }

  assertInvariants(final = false) {
    this.syncMetricsFromStore();
    const failures = [];
    const uniqueBuyerNotifies = this.fake?.getUniqueBuyerNotifyCount() || 0;
    const uniqueBuyers = this.metrics.uniqueBuyerIds.size;
    const processableReplies = this.metrics.uniqueProcessableWechatReplyKeys.size;
    const actualAttempts = this.metrics.qianfanSendActualAttempts;
    const successReceipts = this.fake?.getSuccessReceiptCount() || 0;
    const failureActualSent = this.metrics.failureReceiptActualSent;
    const uniqueFailureKeys = this.metrics.uniqueFailureReceiptKeys.size;

    if (uniqueBuyerNotifies > uniqueBuyers) {
      failures.push(
        `uniqueBuyerNotifies ${uniqueBuyerNotifies} > unique buyer messages ${uniqueBuyers}`,
      );
    }
    if (actualAttempts > processableReplies && processableReplies > 0) {
      failures.push(
        `qianfanSendActualAttempts ${actualAttempts} > uniqueProcessableWechatReplyKeys ${processableReplies}`,
      );
    }
    if (successReceipts > 0) {
      failures.push(`success receipts must be 0, got ${successReceipts}`);
    }
    if (failureActualSent > uniqueFailureKeys) {
      failures.push(
        `failureReceiptActualSent ${failureActualSent} > uniqueFailureReceiptKeys ${uniqueFailureKeys}`,
      );
    }
    if (final && this.metrics.failureReceiptsSent > 0 && failureActualSent === 0) {
      failures.push('failure receipt map out of sync with wechat sent log');
    }

    if (final && this.fake) {
      for (const workerName of START_ORDER) {
        const status = this.fake.getWorkerStatus(workerName);
        if (status.restartPolicy?.failed) {
          this.metrics.recordRestartCircuitBreak();
        }
      }
    }

    for (const msg of failures) {
      if (!this.metrics.invariantFailures.includes(msg)) {
        let type = 'other';
        if (msg.includes('qianfanSendActualAttempts')) type = 'qianfan_send_excess';
        if (msg.includes('failureReceipt')) type = 'failure_receipt_excess';
        if (msg.includes('success receipts')) type = 'success_receipt';
        if (msg.includes('notifications')) type = 'notification_excess';
        this.metrics.addInvariantFailure(msg, type);
      }
    }
    return failures.length === 0;
  }

  async runScenario(scenario = {}) {
    const profile = scenario.profile || {};
    const days = Number(scenario.days || 1);
    this.seed = Number(scenario.seed || this.seed);
    this.generator.seed = this.seed;

    if (scenario.fastMode) {
      return this.runScenarioFast(scenario);
    }

    for (let day = 0; day < days; day += 1) {
      this.clock.advanceDays(1);
      await this.runDay(day, profile);
    }
    return this.finishScenario(scenario);
  }

  async runScenarioFast(scenario = {}) {
    const profile = scenario.profile || {};
    const totalDays = Number(scenario.days || 1);
    const batchDays = Number(scenario.batchDays || Math.min(100, totalDays));
    const sampleIterations = Number(scenario.sampleIterations || Math.ceil(totalDays / batchDays));
    const virtualBatchDays = Number(scenario.virtualBatchDays || batchDays);

    let processedDays = 0;
    for (let i = 0; i < sampleIterations && processedDays < totalDays; i += 1) {
      const dayIndex = i % Math.max(batchDays, 1);
      this.clock.advanceDays(virtualBatchDays);
      await this.runDay(dayIndex, profile);
      processedDays += virtualBatchDays;
      this.metrics.daysSimulated = Math.min(totalDays, processedDays);
    }
    this.metrics.daysSimulated = totalDays;
    return this.finishScenario(scenario);
  }

  async finishScenario(scenario) {
    this.metrics.invariantFailures = [];
    this.metrics.invariantFailuresByType = {};
    this.assertInvariants(true);
    const leak = this.leakDetector.snapshotEnd({
      logsDir: path.join(this.testDataDir, 'logs'),
      dataDir: this.testDataDir,
    });
    const leakEval = this.leakDetector.evaluate(this.metrics);
    for (const msg of leakEval.failures) this.metrics.addInvariantFailure(msg);

    this.metrics.setFileStats(
      countFiles(path.join(this.testDataDir, 'logs')),
      countFiles(this.testDataDir),
    );

    const passed = this.metrics.invariantFailures.length === 0 && this.metrics.successReceiptsSent === 0;
    const report = this.writeReport(scenario, leakEval, passed);
    return { passed, metrics: this.metrics.snapshot(), report };
  }

  getMetrics() {
    this.syncMetricsFromStore();
    return this.metrics.snapshot();
  }

  writeReport(scenario, leakEval = {}, passed = false) {
    return writeReportBundle({
      reportDir: this.reportDir,
      scenario,
      metrics: this.metrics.snapshot(),
      invariants: this.metrics.invariantFailures,
      errors: this.errors,
      leak: leakEval,
      passed,
    });
  }

  async cleanup(removeData = false) {
    await this.stop();
    if (removeData) cleanupTestDir(this.testDataDir);
  }

  countRunningWorkerPids() {
    if (!this.fake) return 0;
    const status = this.fake.getStatus();
    return (status.workers || []).filter((w) => w.pid && w.status === 'running').length;
  }
}

module.exports = {
  LongrunHarness,
};
