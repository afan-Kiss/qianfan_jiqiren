const fs = require('fs');
const path = require('path');

const sentTexts = [];
const sentImages = [];

function appendSimLog(name, entry) {
  const dir = process.env.QIANFAN_SIM_DATA_DIR;
  if (!dir) return;
  const file = path.join(dir, name);
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

function install() {
  const wechatSendApi = require('../../src/wechat-send-api');
  wechatSendApi.sendWxText = async (wxid, content) => {
    const { readState } = require('./sim-chaos-state');
    const chaos = readState();
    if (process.env.QIANFAN_SIM_WECHAT_NOTIFY_FAIL === '1' || chaos.wechatNotifyFail) {
      throw new Error('sim wechat notify failure');
    }
    const entry = { wxid, content, time: Date.now(), kind: 'text' };
    sentTexts.push(entry);
    appendSimLog('sim-wechat-sent.jsonl', entry);
    return { body: { code: 0 }, wxMsgId: `sim-wx-${sentTexts.length}` };
  };
  wechatSendApi.sendWxBuyerImages = async (wxid, options = {}) => {
    sentImages.push({ wxid, options, time: Date.now() });
    return { sent: 0, usedLink: false };
  };
}

function reset() {
  sentTexts.length = 0;
  sentImages.length = 0;
}

function getSentTexts() {
  return [...sentTexts];
}

function getNotifyTexts() {
  return sentTexts.filter((item) => String(item.content || '').includes('【千帆待回复'));
}

function getFailureReceipts() {
  return sentTexts.filter((item) => String(item.content || '').includes('❌ 回复失败'));
}

function getSuccessReceipts() {
  return sentTexts.filter(
    (item) => String(item.content || '').includes('✅') || String(item.content || '').includes('已回复'),
  );
}

module.exports = {
  install,
  reset,
  getSentTexts,
  getNotifyTexts,
  getFailureReceipts,
  getSuccessReceipts,
};
