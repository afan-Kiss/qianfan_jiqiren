const { hashText, normalizeReplyTextForDedup } = require('../../src/runtime/idempotency-keys');

function normalizeReplyText(text = '', replyId = '') {
  return normalizeReplyTextForDedup(text, replyId);
}

class LongrunMetrics {
  constructor() {
    this.reset();
  }

  reset() {
    this.daysSimulated = 0;
    this.buyerMessagesGenerated = 0;
    this.buyerMessagesDuplicate = 0;
    this.wechatRepliesGenerated = 0;
    this.wechatRepliesDuplicate = 0;
    this.notificationsAttempted = 0;
    this.notificationsSucceeded = 0;
    this.notificationsFailed = 0;
    this.uniqueBuyerNotifies = 0;
    this.qianfanSendAttempted = 0;
    this.qianfanSendSucceeded = 0;
    this.qianfanSendFailed = 0;
    this.successReceiptsSent = 0;
    this.failureReceiptsSent = 0;
    this.deadLetters = 0;
    this.workerCrashes = 0;
    this.watchdogTimeouts = 0;
    this.workerRestarts = 0;
    this.restartCircuitBreaks = 0;
    this.persistenceTimeouts = 0;
    this.rendererRefreshes = 0;
    this.runtimeRestarts = 0;
    this.maxMemoryMB = 0;
    this.startMemoryMB = 0;
    this.endMemoryMB = 0;
    this.activeHandlesStart = 0;
    this.activeHandlesEnd = 0;
    this.logsWritten = 0;
    this.dataFilesWritten = 0;
    this.invariantFailures = [];
    this.invariantFailuresByType = {};

    this.uniqueBuyerIds = new Set();
    this.uniqueReplyIds = new Set();
    this.uniqueBuyerMessageKeys = new Set();
    this.uniqueWechatReplyKeys = new Set();
    this.uniqueProcessableWechatReplyKeys = new Set();
    this.uniqueQianfanSendKeys = new Set();
    this.uniqueQianfanSendResultKeys = new Set();
    this.uniqueFailureReceiptKeys = new Set();
    this.uniqueFailedSendKeys = new Set();
    this.uniquePendingMissingKeys = new Set();

    this.qianfanSendRequestsPublished = 0;
    this.qianfanSendRequestsDeduped = 0;
    this.qianfanSendActualAttempts = 0;
    this.qianfanSendResultEvents = 0;
    this.failureReceiptRequests = 0;
    this.failureReceiptDeduped = 0;
    this.failureReceiptActualSent = 0;
    this.deadLettersByReason = {};
  }

  recordBuyerMessage(event, duplicate = false) {
    this.buyerMessagesGenerated += 1;
    const messageId = event.messageId || event.message?.msgId;
    if (duplicate) {
      this.buyerMessagesDuplicate += 1;
      return;
    }
    this.uniqueBuyerIds.add(messageId);
    this.uniqueBuyerMessageKeys.add(messageId);
  }

  recordWechatReply(event, duplicate = false) {
    this.wechatRepliesGenerated += 1;
    if (duplicate) {
      this.wechatRepliesDuplicate += 1;
      return;
    }
    this.uniqueReplyIds.add(event.wxMsgId);
    this.uniqueWechatReplyKeys.add(event.wxMsgId);
    const normalized = normalizeReplyText(event.text, event.replyId);
    const processableKey = `${event.replyId}:${hashText(normalized)}`;
    this.uniqueProcessableWechatReplyKeys.add(processableKey);
    this.qianfanSendRequestsPublished += 1;
    this.uniqueQianfanSendKeys.add(processableKey);
  }

  recordWechatReplyDuplicate() {
    this.wechatRepliesDuplicate += 1;
    this.qianfanSendRequestsDeduped += 1;
  }

  recordQianfanSendRequestDeduped() {
    this.qianfanSendRequestsDeduped += 1;
  }

  recordNotification(success) {
    this.notificationsAttempted += 1;
    if (success) this.notificationsSucceeded += 1;
    else this.notificationsFailed += 1;
  }

  recordQianfanSend(success, key = '') {
    this.qianfanSendAttempted += 1;
    if (success) {
      this.qianfanSendSucceeded += 1;
      if (key) this.uniqueQianfanSendResultKeys.add(`${key}:success`);
    } else {
      this.qianfanSendFailed += 1;
      if (key) {
        this.uniqueFailedSendKeys.add(key);
        this.uniqueQianfanSendResultKeys.add(`${key}:failed`);
      }
    }
  }

  recordQianfanSendResultEvent(key = '') {
    this.qianfanSendResultEvents += 1;
    if (key) this.uniqueQianfanSendResultKeys.add(key);
  }

  recordSuccessReceipt() {
    this.successReceiptsSent += 1;
  }

  recordFailureReceiptRequest(key, deduped = false) {
    this.failureReceiptRequests += 1;
    if (deduped) {
      this.failureReceiptDeduped += 1;
      return;
    }
    if (key) this.uniqueFailureReceiptKeys.add(key);
  }

  recordFailureReceiptSent(key, reasonType = 'unknown') {
    if (key && this.uniqueFailureReceiptKeys.has(key)) return;
    if (key) this.uniqueFailureReceiptKeys.add(key);
    this.failureReceiptActualSent += 1;
    this.failureReceiptsSent += 1;
    if (reasonType === 'PENDING_MISSING' && key) {
      this.uniquePendingMissingKeys.add(key);
    }
    if (reasonType === 'QIANFAN_SEND_FAILED' && key) {
      this.uniqueFailedSendKeys.add(key);
    }
  }

  recordDeadLetter(count, reason = 'unknown') {
    this.deadLetters = Math.max(this.deadLetters, count);
    this.deadLettersByReason[reason] = (this.deadLettersByReason[reason] || 0) + 1;
  }

  recordWorkerCrash() {
    this.workerCrashes += 1;
    this.workerRestarts += 1;
  }

  recordWatchdogTimeout() {
    this.watchdogTimeouts += 1;
    this.workerRestarts += 1;
  }

  recordRestartCircuitBreak() {
    this.restartCircuitBreaks += 1;
  }

  recordPersistenceTimeout() {
    this.persistenceTimeouts += 1;
  }

  recordRendererRefresh() {
    this.rendererRefreshes += 1;
  }

  recordRuntimeRestart() {
    this.runtimeRestarts += 1;
  }

  setQianfanSendActualAttempts(count) {
    this.qianfanSendActualAttempts = count;
  }

  updateMemory() {
    const rss = process.memoryUsage().rss / (1024 * 1024);
    this.endMemoryMB = rss;
    this.maxMemoryMB = Math.max(this.maxMemoryMB, rss);
  }

  setStartMemory() {
    this.startMemoryMB = process.memoryUsage().rss / (1024 * 1024);
    this.maxMemoryMB = this.startMemoryMB;
  }

  setHandles(start, end) {
    this.activeHandlesStart = start;
    this.activeHandlesEnd = end;
  }

  setFileStats(logsWritten, dataFilesWritten) {
    this.logsWritten = logsWritten;
    this.dataFilesWritten = dataFilesWritten;
  }

  addInvariantFailure(message, type = 'other') {
    this.invariantFailures.push(message);
    this.invariantFailuresByType[type] = (this.invariantFailuresByType[type] || 0) + 1;
  }

  snapshot() {
    return {
      daysSimulated: this.daysSimulated,
      buyerMessagesGenerated: this.buyerMessagesGenerated,
      buyerMessagesDuplicate: this.buyerMessagesDuplicate,
      uniqueBuyerMessages: this.uniqueBuyerIds.size,
      uniqueBuyerMessageKeys: this.uniqueBuyerMessageKeys.size,
      wechatRepliesGenerated: this.wechatRepliesGenerated,
      wechatRepliesDuplicate: this.wechatRepliesDuplicate,
      uniqueWechatReplies: this.uniqueReplyIds.size,
      uniqueWechatReplyKeys: this.uniqueWechatReplyKeys.size,
      uniqueProcessableWechatReplyKeys: this.uniqueProcessableWechatReplyKeys.size,
      notificationsAttempted: this.notificationsAttempted,
      notificationsSucceeded: this.notificationsSucceeded,
      notificationsFailed: this.notificationsFailed,
      uniqueBuyerNotifies: this.uniqueBuyerNotifies,
      qianfanSendAttempted: this.qianfanSendAttempted,
      qianfanSendSucceeded: this.qianfanSendSucceeded,
      qianfanSendFailed: this.qianfanSendFailed,
      uniqueQianfanSendKeys: this.uniqueQianfanSendKeys.size,
      qianfanSendRequestsPublished: this.qianfanSendRequestsPublished,
      qianfanSendRequestsDeduped: this.qianfanSendRequestsDeduped,
      qianfanSendActualAttempts: this.qianfanSendActualAttempts,
      qianfanSendResultEvents: this.qianfanSendResultEvents,
      uniqueQianfanSendResultKeys: this.uniqueQianfanSendResultKeys.size,
      successReceiptsSent: this.successReceiptsSent,
      failureReceiptsSent: this.failureReceiptsSent,
      failureReceiptRequests: this.failureReceiptRequests,
      failureReceiptDeduped: this.failureReceiptDeduped,
      failureReceiptActualSent: this.failureReceiptActualSent,
      uniqueFailureReceiptKeys: this.uniqueFailureReceiptKeys.size,
      uniqueFailedSendKeys: this.uniqueFailedSendKeys.size,
      uniquePendingMissingKeys: this.uniquePendingMissingKeys.size,
      deadLetters: this.deadLetters,
      deadLettersByReason: { ...this.deadLettersByReason },
      workerCrashes: this.workerCrashes,
      watchdogTimeouts: this.watchdogTimeouts,
      workerRestarts: this.workerRestarts,
      restartCircuitBreaks: this.restartCircuitBreaks,
      persistenceTimeouts: this.persistenceTimeouts,
      rendererRefreshes: this.rendererRefreshes,
      runtimeRestarts: this.runtimeRestarts,
      maxMemoryMB: Number(this.maxMemoryMB.toFixed(2)),
      startMemoryMB: Number(this.startMemoryMB.toFixed(2)),
      endMemoryMB: Number(this.endMemoryMB.toFixed(2)),
      activeHandlesStart: this.activeHandlesStart,
      activeHandlesEnd: this.activeHandlesEnd,
      logsWritten: this.logsWritten,
      dataFilesWritten: this.dataFilesWritten,
      invariantFailures: [...this.invariantFailures],
      invariantFailuresByType: { ...this.invariantFailuresByType },
    };
  }
}

module.exports = {
  LongrunMetrics,
  normalizeReplyText,
};
