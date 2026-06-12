const config = require('../wechat/wxbot-new-config');
const { sendWxText } = require('../wechat-send-api');
const { findBridgeByShopTitle, sendQianfanTextReply, resolveReplyContextForSend } = require('../qianfan-ws-bridge');
const { withTimeout } = require('../cdp-timeout');
const { ok, fail } = require('./adapter-result');
const { println } = require('../utils');

const QIANFAN_SEND_TOTAL_TIMEOUT_MS = 55000;
const isDistributed = () => process.env.QIANFAN_DISTRIBUTED_RUNTIME === '1';

function formatQianfanSendErrorMessage(message) {
  const reason = String(message || '');
  if (/sendQianfanTextReply timeout/i.test(reason)) {
    return '千帆发送流程超时，可能 WS 唤醒/ACK 卡住，请到千帆手动确认是否已发出';
  }
  if (/resolveReplyContextForSend timeout/i.test(reason)) {
    return '千帆会话解析超时，请让买家再发一条消息或到千帆手动回复';
  }
  return reason;
}

function formatFailureReceipt({ replyId, pending, reason, text }) {
  if (!replyId) {
    return [
      '❌ 回复失败',
      `原因：${reason}`,
      '请引用【千帆待回复 #编号】消息回复，或用「#编号 回复内容」',
    ].join('\n');
  }
  const lines = [`❌ 回复失败 #${replyId}`];
  if (pending?.shopTitle) lines.push(`店铺：${pending.shopTitle}`);
  if (pending?.buyerNick) lines.push(`买家：${pending.buyerNick}`);
  lines.push(`原因：${reason}`);
  if (text) lines.push(`内容：${text}`);
  return lines.join('\n');
}

async function sendFailureReceipt({ replyId, pending, reason, text, fromWxid }) {
  const wxid = fromWxid || config.authorizedReplyWxid || config.notifyReceiverAccount?.wxid;
  if (!wxid || config.dryRun) return ok({ skipped: true });
  const content = formatFailureReceipt({ replyId, pending, reason, text });
  await sendWxText(wxid, content);
  return ok({ sent: true, kind: 'failure_receipt' });
}

async function sendQianfanReplyRequest(request = {}) {
  let {
    replyId,
    replyText,
    pending,
    receiverAppUids,
    fromWxid,
  } = request;

  try {
    if (!replyId || !pending) {
      if (!isDistributed()) {
        await sendFailureReceipt({
          replyId,
          pending,
          reason: '缺少 replyId 或 pending 上下文',
          text: replyText,
          fromWxid,
        });
      }
      return fail(new Error('缺少 replyId 或 pending 上下文'), 'INVALID_REQUEST');
    }

    if (!findBridgeByShopTitle(pending.shopTitle)) {
      const reason = '店铺页面未接入，请到千帆手动回复';
      if (!isDistributed()) {
        await sendFailureReceipt({ replyId, pending, reason, text: replyText, fromWxid });
      }
      return fail(new Error(reason), 'SHOP_NOT_ATTACHED');
    }

    try {
      const live = await withTimeout(
        resolveReplyContextForSend(pending.shopTitle, pending.buyerNick, pending.appCid),
        12000,
        'resolveReplyContextForSend',
      );
      if (live) {
        pending = {
          ...pending,
          appCid: live.appCid || pending.appCid,
          buyerNick: live.buyerNick || pending.buyerNick,
          receiverAppUids: live.receiverAppUids?.length ? live.receiverAppUids : pending.receiverAppUids,
        };
        receiverAppUids = pending.receiverAppUids;
      }
    } catch (err) {
      println(`[千帆发送] 实时会话解析失败，使用 pending 上下文：${err.message || err}`);
    }

    if (!pending.appCid) {
      const reason = '缺少买家会话 appCid，请让买家再发一条消息或到千帆手动回复';
      if (!isDistributed()) {
        await sendFailureReceipt({ replyId, pending, reason, text: replyText, fromWxid });
      }
      return fail(new Error(reason), 'MISSING_APPCID');
    }

    if (!receiverAppUids?.length) {
      const reason = '缺少买家 receiverAppUids，请到千帆手动回复';
      if (!isDistributed()) {
        await sendFailureReceipt({ replyId, pending, reason, text: replyText, fromWxid });
      }
      return fail(new Error(reason), 'MISSING_RECEIVER');
    }

    const ack = await withTimeout(
      sendQianfanTextReply({
        shopTitle: pending.shopTitle,
        appCid: pending.appCid,
        receiverAppUids,
        text: replyText,
        buyerNick: pending.buyerNick,
      }),
      QIANFAN_SEND_TOTAL_TIMEOUT_MS,
      'sendQianfanTextReply',
    );

    if (!isDistributed()) {
      const dataStore = require('../qianfan-data-store');
      dataStore.markWechatReplyProcessed({ wechatReplyMsgId: request.wxMsgId, replyId });
      dataStore.updatePendingAfterReply(replyId);
      dataStore.appendSentReply({
        replyId,
        wechatReplyMsgId: request.wxMsgId,
        qianfanMsgId: ack.msgId,
        text: replyText,
        sentAt: Date.now(),
        status: 'sent',
      });
    }

    return ok({
      success: true,
      replyId,
      qianfanMsgId: ack.msgId,
    });
  } catch (err) {
    const reason = formatQianfanSendErrorMessage(err.message || err);
    if (!isDistributed()) {
      await sendFailureReceipt({ replyId, pending, reason, text: replyText, fromWxid });
    }
    return fail(new Error(reason), 'QIANFAN_SEND_FAILED', { reason });
  }
}

module.exports = {
  sendQianfanReplyRequest,
  sendFailureReceipt,
  formatQianfanSendErrorMessage,
};
