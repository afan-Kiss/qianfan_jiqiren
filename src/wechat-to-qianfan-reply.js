/**
 * 二号微信引用回复 → 千帆买家
 */
const fs = require('fs');
const path = require('path');
const config = require('./wechat/wxbot-new-config');
const { isAuthorizedReplyWxid, getAuthorizedReplyWxids } = config;
const { println } = require('./utils');
const { sendWxText } = require('./wechat-send-api');
const { formatWechatSendConsoleLine } = require('./wxbot-new-callback-log');
const {
  parseAuthorizedWechatReply,
  parseRobotNotificationForMap,
  shouldNotifyInvalidReply,
  formatInvalidReplyReason,
} = require('./wechat-reply-parser');
const {
  recordSentNotification,
  findPendingByReplyId,
  getReceiverAppUids,
  appendSentReply,
  hasSuccessfulReplyForReplyId,
  updatePendingAfterReply,
  isDuplicateWechatReply,
  markWechatReplyProcessed,
} = require('./qianfan-data-store');
const { sendQianfanTextReply, findBridgeByShopTitle } = require('./qianfan-ws-bridge');
const { withTimeout } = require('./cdp-timeout');

const QIANFAN_SEND_TOTAL_TIMEOUT_MS = 55000;

function debugLogPath() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const dir = path.join(config.root, 'logs', 'debug');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `wechat-reply-to-qianfan-${y}-${m}-${day}.jsonl`);
}

function debugLog(entry) {
  fs.appendFileSync(debugLogPath(), `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

async function sendReceiptToNotifyAccount(content, wxid) {
  const target = String(wxid || '').trim() || getAuthorizedReplyWxids()[0] || config.notifyReceiverAccount?.wxid;
  if (!target || config.dryRun) return;
  println(formatWechatSendConsoleLine({ wxid: target, content, label: '二号回执' }));
  await sendWxText(target, content);
}

function formatSuccessReceipt(replyId, pending, text, isAppend) {
  const head = isAppend ? `✅ 已追加回复 #${replyId}` : `✅ 已回复 #${replyId}`;
  return [head, `店铺：${pending.shopTitle}`, `买家：${pending.buyerNick || '买家'}`, `内容：${text}`].join('\n');
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

function createWechatToQianfanDispatcher() {
  const robotWxid = config.robotAccount?.wxid || config.loginBotWxid;

  async function handleCallback(parsed, body) {
    debugLog({ event: 'callback', from: parsed.from, to: parsed.to, wxMsgId: parsed.wxMsgId });

    const mapEntry = parseRobotNotificationForMap(parsed, body);
    if (mapEntry) {
      recordSentNotification(mapEntry);
      println(`[微信] 已补录通知映射：wxMsgId=${mapEntry.wxMsgId} -> #${mapEntry.replyId}`);
      debugLog({ event: 'sent_map_recorded', ...mapEntry });
    }

    if (!isAuthorizedReplyWxid(parsed.from)) {
      if (parsed.from && parsed.from !== robotWxid) {
        // 非授权账号：不打印，避免刷屏
      }
      return;
    }

    const reply = parseAuthorizedWechatReply(parsed, body);
    debugLog({ event: 'parsed_reply', reply });

    if (!reply.ok) {
      if (!shouldNotifyInvalidReply(reply)) {
        debugLog({ event: 'ignored_non_reply', reason: reply.reason, from: parsed.from });
        return;
      }
      const receipt = formatFailureReceipt({
        replyId: reply.replyId || null,
        reason: formatInvalidReplyReason(reply.reason),
        text: reply.rawText || '',
      });
      try {
        await sendReceiptToNotifyAccount(receipt, parsed.from);
      } catch (err) {
        println(`[错误] 回执发送失败：${err.message || err}`);
      }
      return;
    }

    const { replyId, replyText, wxMsgId, mode } = reply;

    if (
      isDuplicateWechatReply({
        wechatReplyMsgId: wxMsgId,
        replyId,
        fromWxid: parsed.from,
        text: replyText,
      })
    ) {
      println(`[忽略] 重复微信回复：#${replyId} ${replyText}`);
      return;
    }

    const pending = findPendingByReplyId(replyId);
    if (!pending) {
      const receipt = formatFailureReceipt({
        replyId,
        reason: '未找到对应千帆待回复记录，请到千帆手动回复',
        text: replyText,
      });
      println(`[错误] #${replyId} 回复失败：未找到 pending`);
      try {
        await sendReceiptToNotifyAccount(receipt, parsed.from);
      } catch (err) {
        println(`[错误] 回执发送失败：${err.message || err}`);
      }
      return;
    }

    if (!pending.appCid) {
      const receipt = formatFailureReceipt({
        replyId,
        pending,
        reason: '未找到对应千帆会话 appCid，请到千帆手动回复',
        text: replyText,
      });
      println(`[错误] #${replyId} 回复失败：缺少 appCid`);
      try {
        await sendReceiptToNotifyAccount(receipt, parsed.from);
      } catch (err) {
        println(`[错误] 回执发送失败：${err.message || err}`);
      }
      return;
    }

    let receiverAppUids = Array.isArray(pending.receiverAppUids)
      ? pending.receiverAppUids.filter(Boolean)
      : [];
    if (!receiverAppUids.length) {
      receiverAppUids = getReceiverAppUids(pending.appCid);
    }
    if (!receiverAppUids.length) {
      const receipt = formatFailureReceipt({
        replyId,
        pending,
        reason: '缺少买家 receiverAppUids，请到千帆手动回复',
        text: replyText,
      });
      println(`[错误] #${replyId} 回复失败：缺少 receiverAppUids`);
      try {
        await sendReceiptToNotifyAccount(receipt, parsed.from);
      } catch (err) {
        println(`[错误] 回执发送失败：${err.message || err}`);
      }
      return;
    }

    if (!findBridgeByShopTitle(pending.shopTitle)) {
      const receipt = formatFailureReceipt({
        replyId,
        pending,
        reason: '店铺页面未接入，请到千帆手动回复',
        text: replyText,
      });
      println(`[错误] #${replyId} 回复失败：店铺页面未接入`);
      try {
        await sendReceiptToNotifyAccount(receipt, parsed.from);
      } catch (err) {
        println(`[错误] 回执发送失败：${err.message || err}`);
      }
      return;
    }

    const modeLabel = mode === 'quote' ? '引用' : '#编号';
    println(`[回复] 收到二号${modeLabel}回复：#${replyId} 内容=${replyText}`);
    println(`[千帆] 正在发送回复：店铺=${pending.shopTitle} 买家=${pending.buyerNick || '买家'}`);

    try {
      const isAppend = hasSuccessfulReplyForReplyId(replyId);
      const ack = await withTimeout(
        sendQianfanTextReply({
          shopTitle: pending.shopTitle,
          appCid: pending.appCid,
          receiverAppUids,
          text: replyText,
        }),
        QIANFAN_SEND_TOTAL_TIMEOUT_MS,
        'sendQianfanTextReply'
      );

      markWechatReplyProcessed({ wechatReplyMsgId: wxMsgId, replyId });
      updatePendingAfterReply(replyId);
      appendSentReply({
        replyId,
        wechatReplyMsgId: wxMsgId,
        qianfanMsgId: ack.msgId,
        text: replyText,
        sentAt: Date.now(),
        status: 'sent',
      });

      println(`[回复] #${replyId} 已发送千帆 msgId=${ack.msgId}`);
      debugLog({
        event: 'sent_ok',
        replyId,
        wxMsgId,
        qianfanMsgId: ack.msgId,
        text: replyText,
        isAppend,
      });

      const receipt = formatSuccessReceipt(replyId, pending, replyText, isAppend);
      await sendReceiptToNotifyAccount(receipt, parsed.from);
      println(`[微信] 已发送回复回执：#${replyId}`);
    } catch (err) {
      let reason = String(err.message || err);
      if (/sendQianfanTextReply timeout/i.test(reason)) {
        reason = '千帆发送流程超时，可能 ACK/UI 同步/回显卡住，请到千帆手动确认';
      }
      println(`[错误] #${replyId} 回复失败：${reason}`);
      debugLog({ event: 'sent_fail', replyId, error: reason, text: replyText });

      const receipt = formatFailureReceipt({
        replyId,
        pending,
        reason,
        text: replyText,
      });
      try {
        await sendReceiptToNotifyAccount(receipt, parsed.from);
      } catch (sendErr) {
        println(`[错误] 回执发送失败：${sendErr.message || sendErr}`);
      }
    }
  }

  return { handleCallback };
}

module.exports = {
  createWechatToQianfanDispatcher,
};
