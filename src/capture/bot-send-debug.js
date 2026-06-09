/**
 * 机器人 WebSocket 发送一次性调试日志（供 qianfan-ws-bridge 引用）
 */
const fs = require('fs');
const path = require('path');

function debugDir() {
  const dir = path.join(process.cwd(), 'tmp', 'bot-send-debug');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function datedLogPath(prefix) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(debugDir(), `${prefix}-${y}-${m}-${day}.jsonl`);
}

function appendJsonl(filePath, entry) {
  fs.appendFileSync(filePath, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

function writeBotSendTrace(entry) {
  appendJsonl(datedLogPath('qianfan-send-debug'), entry);
}

function summarizePayload(payload) {
  const hdr = payload?.header || {};
  const body = payload?.body || {};
  return {
    cmd: hdr.action || '',
    action: hdr.action || '',
    event: hdr.action || '',
    type: hdr.type,
    serviceId: hdr.serviceId,
    seq: hdr.seq,
    traceId: hdr.traceId,
    sMid: hdr.sMid,
    shopId: body.shopId || null,
    buyerId: body.receiverAppUids || body.buyerId || null,
    conversationId: body.appCid || body.conversationId || null,
    staffId: body.staffId || body.operatorId || null,
    clientMsgId: body.uuid || body.clientMsgId || null,
    payloadSummary: {
      appCid: body.appCid,
      receiverAppUids: body.receiverAppUids,
      contentInfo: body.contentInfo,
      extension: body.extension,
      uuid: body.uuid,
    },
  };
}

function logBotSendLifecycle(event, ctx) {
  writeBotSendTrace({
    event,
    shopId: ctx.shopTitle || ctx.shopId,
    buyerId: ctx.receiverAppUids || ctx.buyerId,
    conversationId: ctx.appCid || ctx.conversationId,
    staffId: ctx.staffId || ctx.operatorId || null,
    clientMsgId: ctx.uuid || ctx.clientMsgId,
    msgId: ctx.qianfanMsgId || ctx.msgId || null,
    seq: ctx.seq,
    ackId: ctx.traceId || ctx.ackId,
    gotAck: ctx.gotAck,
    gotMessagePush: ctx.gotMessagePush,
    gotConversationUpdate: ctx.gotConversationUpdate,
    bubbleInserted: ctx.bubbleInserted,
    countdownCleared: ctx.countdownCleared,
    echoReason: ctx.echoReason,
    wsUrl: ctx.wsUrl,
    payloadSummary: ctx.payload ? summarizePayload(ctx.payload) : ctx.payloadSummary,
  });
}

module.exports = {
  writeBotSendTrace,
  logBotSendLifecycle,
  summarizePayload,
};
