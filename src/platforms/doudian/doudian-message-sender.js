const crypto = require('crypto');
const { println } = require('../../shared/logger');
const { getDoudianConfig } = require('../../shared/config');
const { DOUDIAN_EVENTS, SEND_TASK_EVENT, createEnvelope } = require('./doudian-types');
const { insertMessage } = require('./doudian-data-store');
const { normalizeInboundMessage } = require('./doudian-normalizer');

class DoudianMessageSender {
  constructor(options = {}) {
    this.wsServer = options.wsServer;
    this.ready = false;
    this.pendingAcks = new Map();
    this.unsubscribes = [];
  }

  start() {
    if (!this.wsServer) throw new Error('wsServer required');
    if (this.ready) return { ok: true, already: true };

    const offAck = this.wsServer.on(DOUDIAN_EVENTS.MESSAGE_ACK, (envelope) => {
      this.resolvePending(envelope, true);
    });
    const offFail = this.wsServer.on(DOUDIAN_EVENTS.MESSAGE_SEND_FAILED, (envelope) => {
      this.resolvePending(envelope, false);
    });
    const offOutbound = this.wsServer.on(DOUDIAN_EVENTS.MESSAGE_OUTBOUND, (envelope) => {
      const normalized = normalizeInboundMessage({
        ...envelope,
        payload: { ...envelope.payload, direction: 'outbound' },
      });
      normalized.direction = 'outbound';
      insertMessage(normalized);
    });

    this.unsubscribes.push(offAck, offFail, offOutbound);
    this.ready = true;
    println('消息发送器已就绪');
    return { ok: true };
  }

  stop() {
    for (const off of this.unsubscribes) {
      try {
        off && off();
      } catch {
        // ignore
      }
    }
    this.unsubscribes = [];
    for (const [, pending] of this.pendingAcks) {
      clearTimeout(pending.timer);
      pending.reject(new Error('sender stopped'));
    }
    this.pendingAcks.clear();
    this.ready = false;
  }

  resolvePending(envelope, ok) {
    const taskId = envelope.payload?.taskId || envelope.messageId;
    if (!taskId) return;
    const pending = this.pendingAcks.get(taskId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAcks.delete(taskId);
    if (ok) pending.resolve(envelope);
    else pending.reject(new Error(envelope.payload?.reason || 'send_failed'));
  }

  async sendTextTask(task) {
    const cfg = getDoudianConfig();
    const bridge = this.wsServer.getPrimaryBridge();
    if (!bridge) {
      throw new Error('没有可用的 bridge 连接');
    }

    const taskId = task.taskId || crypto.randomBytes(8).toString('hex');
    const payload = {
      taskId,
      text: String(task.text || ''),
      conversationId: task.conversationId || '',
      buyerId: task.buyerId || '',
      replyToMessageId: task.replyToMessageId || '',
      orderId: task.orderId || '',
      aftersaleId: task.aftersaleId || '',
    };

    println(`发送消息任务开始 taskId=${taskId} conversationId=${payload.conversationId || ''}`);

    const envelope = createEnvelope(SEND_TASK_EVENT, {
      bridgeId: bridge.bridgeId,
      conversationId: payload.conversationId,
      buyerId: payload.buyerId,
      messageId: taskId,
      payload,
    });

    const sent = this.wsServer.broadcastToBridge(bridge.bridgeId, envelope);
    if (!sent) {
      throw new Error('向 bridge 下发发送任务失败');
    }

    try {
      const ack = await this.waitAck(taskId, cfg.sendTimeoutMs || 15000);
      println(`发送成功 taskId=${taskId}`);
      return { ok: true, taskId, ack };
    } catch (err) {
      println(`发送失败 taskId=${taskId} reason=${err.message || err}`);
      throw err;
    }
  }

  waitAck(taskId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(taskId);
        reject(new Error('发送 ACK 超时'));
      }, timeoutMs);

      this.pendingAcks.set(taskId, { resolve, reject, timer });
    });
  }
}

module.exports = {
  DoudianMessageSender,
};
