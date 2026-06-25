const config = require('../wechat/wxbot-new-config');
const { sendWxText } = require('../wechat-send-api');
const { findBridgeByShopTitle, sendQianfanTextReply, resolveReplyContextForSend, isBridgeCdpReady, waitForBridgeCdpReady } = require('../qianfan-ws-bridge');
const { isShopQianfanDegraded, getShopDegradedReason } = require('../qianfan-bridge-health-pump');
const { isBuyerListenerActive } = require('./legacy-qianfan-listener-adapter');
const { buyerNickMatches } = require('../qianfan-data-store');
const { withTimeout } = require('../cdp-timeout');
const { ok, fail } = require('./adapter-result');
const { println } = require('../utils');
const { agentDebugLog } = require('../shared/agent-debug-log');

const QIANFAN_SEND_TOTAL_TIMEOUT_MS = 36000;
const BRIDGE_READY_RETRY_MS = 5000;
const isDistributed = () => process.env.QIANFAN_DISTRIBUTED_RUNTIME === '1';

function hasCompletePendingSendContext(pending) {
  return Boolean(
    pending?.appCid &&
    Array.isArray(pending.receiverAppUids) &&
    pending.receiverAppUids.filter(Boolean).length,
  );
}

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

function formatSuccessReceipt(replyId, pending, text, isAppend = false) {
  const head = isAppend ? `✅ 已追加回复 #${replyId}` : `✅ 已回复 #${replyId}`;
  return [head, `店铺：${pending.shopTitle}`, `买家：${pending.buyerNick || '买家'}`, `内容：${text}`].join('\n');
}

async function sendSuccessReceipt({ replyId, pending, text, fromWxid, isAppend = false }) {
  const wxid = fromWxid || config.authorizedReplyWxid || config.notifyReceiverAccount?.wxid;
  if (!wxid || config.dryRun) return ok({ skipped: true });
  const content = formatSuccessReceipt(replyId, pending, text, isAppend);
  await sendWxText(wxid, content);
  return ok({ sent: true, kind: 'success_receipt' });
}

function isLiveContextCompatibleWithPending(pending, live) {
  if (!live || !pending) return false;
  const pendingNick = String(pending.buyerNick || '').trim();
  const liveNick = String(live.buyerNick || '').trim();
  if (pendingNick && liveNick && !buyerNickMatches(pendingNick, liveNick)) return false;
  if (pending.appCid && live.appCid && pending.appCid !== live.appCid) return false;
  return true;
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

    if (isShopQianfanDegraded(pending.shopTitle)) {
      const degraded = getShopDegradedReason(pending.shopTitle);
      const reason = degraded?.reason
        ? `千帆连接降级（${degraded.reason}），消息已加入重试队列`
        : '千帆连接降级，消息已加入重试队列';
      return fail(new Error(reason), 'QIANFAN_DEGRADED');
    }

    let bridge = findBridgeByShopTitle(pending.shopTitle);
    if (!isBuyerListenerActive()) {
      println('[千帆发送] 买家监听句柄未就绪，继续尝试发送（以店铺 CDP 为准）');
    }

    if (!isBridgeCdpReady(bridge)) {
      bridge =
        (await waitForBridgeCdpReady(pending.shopTitle, BRIDGE_READY_RETRY_MS)) ||
        findBridgeByShopTitle(pending.shopTitle) ||
        bridge;
    }
    if (!isBridgeCdpReady(bridge)) {
      const reason = '千帆尚未就绪，请稍候再引用回复';
      if (!isDistributed()) {
        await sendFailureReceipt({ replyId, pending, reason, text: replyText, fromWxid });
      }
      return fail(new Error(reason), 'LISTENER_NOT_READY');
    }

    if (hasCompletePendingSendContext(pending)) {
      receiverAppUids = pending.receiverAppUids.filter(Boolean);
      println(
        `[千帆发送] 使用 pending 会话：买家=${pending.buyerNick || '买家'} appCid=${pending.appCid}`,
      );
    } else {
      try {
        const live = await withTimeout(
          resolveReplyContextForSend(pending.shopTitle, pending.buyerNick, pending.appCid),
          12000,
          'resolveReplyContextForSend',
        );
        if (live && isLiveContextCompatibleWithPending(pending, live)) {
          pending = {
            ...pending,
            appCid: live.appCid || pending.appCid,
            buyerNick: live.buyerNick || pending.buyerNick,
            receiverAppUids: live.receiverAppUids?.length ? live.receiverAppUids : pending.receiverAppUids,
          };
          receiverAppUids = pending.receiverAppUids;
        } else if (live) {
          println(
            `[千帆发送] 忽略 HTTP 会话解析：与 pending 不一致 pending=${pending.buyerNick}/${pending.appCid} live=${live.buyerNick}/${live.appCid}`,
          );
        }
      } catch (err) {
        println(`[千帆发送] 实时会话解析失败，使用 pending 上下文：${err.message || err}`);
      }
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

    agentDebugLog({
      location: 'legacy-qianfan-sender-adapter.js:pre-send',
      message: 'send context resolved',
      hypothesisId: 'H1',
      data: {
        replyId,
        buyerNick: pending.buyerNick || '',
        appCid: pending.appCid || '',
        receiverAppUids: receiverAppUids || [],
        usedPendingContext: hasCompletePendingSendContext(request.pending || pending),
        sendGuardEnabled: Boolean(require('../qianfan-send-guard').getSendOnlyBuyerNick()),
      },
    });

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

    const qianfanMsgId = String(ack?.msgId || '').trim();
    if (!qianfanMsgId) {
      return fail(new Error('千帆发送未返回 msgId，不能标记成功'), 'QIANFAN_SEND_NO_ACK');
    }

    if (!isDistributed()) {
      const dataStore = require('../qianfan-data-store');
      dataStore.markWechatReplyProcessed({ wechatReplyMsgId: request.wxMsgId, replyId });
      dataStore.updatePendingAfterReply(replyId);
      dataStore.appendSentReply({
        replyId,
        wechatReplyMsgId: request.wxMsgId,
        qianfanMsgId,
        text: replyText,
        sentAt: Date.now(),
        status: 'sent',
      });
    }

    return ok({
      success: true,
      replyId,
      qianfanMsgId,
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
  sendSuccessReceipt,
  formatFailureReceipt,
  formatSuccessReceipt,
  formatQianfanSendErrorMessage,
};
