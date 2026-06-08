const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { RuntimeSupervisor } = require('../../src/runtime/supervisor');
const { START_ORDER } = require('../../src/runtime/worker-registry');
const config = require('../../src/wechat/wxbot-new-config');
const {
  sleep,
  collectSupervisorPids,
  forceKillPids,
  isPidAlive,
} = require('../test-utils/cleanup-runtime');

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

class FakeRuntimeHarness {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.resolve(__dirname, '..', '..');
    this.runId = options.runId || `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    this.testDataDir = options.testDataDir || path.join(this.rootDir, 'data', 'test-runtime', this.runId);
    this.logsDir = path.join(this.testDataDir, 'logs');
    this.supervisor = null;
    this.options = options;
    this.traceIds = [];
  }

  buildSimEnv() {
    return {
      QIANFAN_SIM_MODE: '1',
      QIANFAN_SIM_DATA_DIR: this.testDataDir,
      QIANFAN_SIM_MERGE_MS: String(this.options.mergeMs ?? 0),
      WXBOT_NEW_DRY_RUN: '0',
      ...(this.options.simEnv || {}),
    };
  }

  buildSupervisorOptions() {
    return {
      rootDir: this.rootDir,
      logsDir: this.logsDir,
      simEnv: this.buildSimEnv(),
      workerExtraEnv: this.options.workerExtraEnv || {},
      startWorkerDelayMs: this.options.startWorkerDelayMs ?? 150,
      watchdog: this.options.watchdog || {},
      restartPolicy: this.options.restartPolicy || {},
    };
  }

  async prepareDirs() {
    fs.mkdirSync(this.testDataDir, { recursive: true });
    fs.mkdirSync(this.logsDir, { recursive: true });
    writeJson(path.join(this.testDataDir, 'reply-id-counter.json'), { nextReplyId: 91001 });
  }

  async start() {
    await this.prepareDirs();
    this.supervisor = new RuntimeSupervisor(this.buildSupervisorOptions());
    if (this.options.crashWorkers) {
      for (const workerName of this.options.crashWorkers) {
        this.supervisor.markCrashNextStart(workerName);
      }
    }
    await this.supervisor.startAll();
    await this.waitForWorkersRunning(this.options.readyTimeoutMs ?? 8000);
    return this;
  }

  getWorkerPids() {
    if (!this.supervisor) return [];
    return collectSupervisorPids(this.supervisor);
  }

  async stop(options = {}) {
    const verify = options.verify !== false;
    const supervisor = this.supervisor;
    const trackedPids = supervisor ? collectSupervisorPids(supervisor) : [];

    if (supervisor) {
      if (typeof supervisor.cancelAllPendingRestarts === 'function') {
        supervisor.cancelAllPendingRestarts();
      }
      try {
        await supervisor.stopAll('sim-test');
      } catch {
        // ignore
      }
      try {
        supervisor.dispose();
      } catch {
        // ignore
      }
    }
    this.supervisor = null;

    await sleep(300);

    if (trackedPids.length) {
      await forceKillPids(trackedPids);
      await sleep(200);
    }

    if (verify) {
      const alive = [];
      for (const pid of trackedPids) {
        if (await isPidAlive(pid)) alive.push(pid);
      }
      if (alive.length) {
        throw new Error(`residual worker pids after stop: ${alive.join(', ')}`);
      }
    }
  }

  async waitForWorkersRunning(timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const status = this.supervisor.getStatus();
      const workers = status.workers || [];
      const allRunning = workers.every((w) => w.status === 'running');
      if (allRunning && workers.length >= START_ORDER.length) return status;
      await sleep(200);
    }
    throw new Error('workers not running in time');
  }

  async waitFor(conditionFn, timeoutMs = 10000, intervalMs = 200) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await conditionFn()) return true;
      await sleep(intervalMs);
    }
    return false;
  }

  getAuthorizedWxid() {
    return config.authorizedReplyWxid || config.notifyReceiverAccount?.wxid;
  }

  buildBuyerMessage(overrides = {}) {
    return {
      shopTitle: overrides.shopTitle || '模拟店铺',
      appCid: overrides.appCid || `sim-app-cid-${this.runId}`,
      buyerNick: overrides.buyerNick || '模拟买家',
      msgId: overrides.msgId || `sim-buyer-${Date.now()}`,
      text: overrides.text || '你好，这是一条模拟买家消息',
      contentType: 'text',
      createAt: Date.now(),
      senderAppUid: overrides.senderAppUid || 'sim-buyer-uid',
      receiverAppUids: overrides.receiverAppUids || ['sim-receiver-uid'],
      source: 'sim_buyer_message',
      ...overrides,
    };
  }

  async injectBuyerMessage(message, options = {}) {
    const traceId = options.traceId || crypto.randomBytes(8).toString('hex');
    this.traceIds.push(traceId);
    this.supervisor.simInject('qianfan-listener', 'buyer-message', { message, options }, { traceId });
    await sleep(this.options.mergeMs ?? 0);
    await sleep(this.options.injectDelayMs ?? 300);
    return traceId;
  }

  async injectWechatReply({ replyId, text, wxMsgId }, traceId) {
    const parsed = {
      from: this.getAuthorizedWxid(),
      wxMsgId: wxMsgId || `sim-wx-reply-${Date.now()}`,
      content: text || `#${replyId} 模拟回复内容`,
    };
    this.supervisor.simInject(
      'wechat-callback',
      'wechat-reply',
      { parsed, body: {} },
      { traceId: traceId || crypto.randomBytes(8).toString('hex') },
    );
    await sleep(this.options.injectDelayMs ?? 500);
    return parsed.wxMsgId;
  }

  readWechatSent() {
    return readJsonl(path.join(this.testDataDir, 'sim-wechat-sent.jsonl'));
  }

  readQianfanSent() {
    return readJsonl(path.join(this.testDataDir, 'sim-qianfan-sent.jsonl'));
  }

  readPending() {
    return readJson(path.join(this.testDataDir, 'pending-notifications.json'), []);
  }

  readSentReplies() {
    return readJson(path.join(this.testDataDir, 'qianfan-sent-replies.json'), []);
  }

  readDeadLetters() {
    return readJson(path.join(this.testDataDir, 'dead-letters.json'), []);
  }

  readFailureReceiptMap() {
    return readJson(path.join(this.testDataDir, 'failure-receipt-sent.json'), {});
  }

  getNotifyCount() {
    return this.readWechatSent().filter((item) => String(item.content || '').includes('【千帆待回复')).length;
  }

  getUniqueBuyerNotifyCount() {
    const replyIds = new Set();
    for (const item of this.readWechatSent()) {
      if (!String(item.content || '').includes('【千帆待回复')) continue;
      const match = String(item.content || '').match(/#(\d+)/);
      if (match) replyIds.add(match[1]);
    }
    return replyIds.size;
  }

  getFailureReceiptCount() {
    return this.readWechatSent().filter((item) => String(item.content || '').includes('❌ 回复失败')).length;
  }

  getSuccessReceiptCount() {
    return this.readWechatSent().filter(
      (item) => String(item.content || '').includes('✅') || String(item.content || '').includes('已回复'),
    ).length;
  }

  getQianfanSendCount() {
    return this.readQianfanSent().length;
  }

  getQianfanAttemptCount() {
    return readJsonl(path.join(this.testDataDir, 'sim-qianfan-attempts.jsonl')).filter(
      (item) => item && item.attempt,
    ).length;
  }

  async restartWorker(workerName, reason = 'manual') {
    await this.supervisor.restartWorker(workerName, reason, { manual: true });
    await this.waitForWorkersRunning();
  }

  stopWorkerHeartbeat(workerName) {
    return this.supervisor.sendSimCommand(workerName, 'stopHeartbeat');
  }

  getWorkerStatus(workerName) {
    return this.supervisor.getWorkerStatus(workerName);
  }

  getStatus() {
    return this.supervisor.getStatus();
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function cleanupTestDir(testDataDir) {
  if (!testDataDir || !fs.existsSync(testDataDir)) return;
  fs.rmSync(testDataDir, { recursive: true, force: true });
}

module.exports = {
  FakeRuntimeHarness,
  sleep,
  readJson,
  readJsonl,
  cleanupTestDir,
};
