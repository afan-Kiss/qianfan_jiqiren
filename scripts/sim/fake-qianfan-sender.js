const fs = require('fs');
const path = require('path');

const sentReplies = [];
let actualAttempts = 0;

function appendSimLog(fileName, entry) {
  const dir = process.env.QIANFAN_SIM_DATA_DIR;
  if (!dir) return;
  const file = path.join(dir, fileName);
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

function shouldFail() {
  if (process.env.QIANFAN_SIM_QIANFAN_SEND_FAIL === '1') return true;
  try {
    const { readState } = require('./sim-chaos-state');
    return Boolean(readState().qianfanSendFail);
  } catch {
    return false;
  }
}

function install() {
  const qianfanBridge = require('../../src/qianfan-ws-bridge');
  qianfanBridge.findBridgeByShopTitle = (shopTitle) => ({
    shopTitle: shopTitle || 'sim-shop',
    attached: true,
  });
  qianfanBridge.sendQianfanTextReply = async (payload = {}) => {
    actualAttempts += 1;
    const attemptEntry = {
      replyId: payload.replyId,
      text: payload.text || payload.replyText,
      at: Date.now(),
      attempt: actualAttempts,
    };
    appendSimLog('sim-qianfan-attempts.jsonl', { ...attemptEntry, status: shouldFail() ? 'failed' : 'success' });
    if (shouldFail()) {
      throw new Error(process.env.QIANFAN_SIM_QIANFAN_SEND_ERROR || 'sim qianfan send failure');
    }
    const entry = {
      ...payload,
      msgId: `sim-qf-${sentReplies.length + 1}`,
      time: Date.now(),
    };
    sentReplies.push(entry);
    appendSimLog('sim-qianfan-sent.jsonl', entry);
    return { msgId: entry.msgId };
  };
}

function reset() {
  sentReplies.length = 0;
  actualAttempts = 0;
}

function getActualAttempts() {
  return actualAttempts;
}

function getSentReplies() {
  return [...sentReplies];
}

module.exports = {
  install,
  reset,
  getSentReplies,
  getActualAttempts,
  shouldFail,
};
