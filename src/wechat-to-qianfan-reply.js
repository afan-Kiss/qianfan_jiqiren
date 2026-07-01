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
  parseReplyIdFromText,
} = require('./wechat-reply-parser');
const {
  recordSentNotification,
  findPendingByReplyId,
  lookupSentNotificationByWxMsgId,
  buyerNickMatches,
  normalizeShopKey,
  parseNoticeContextFromText,
  appendSentReply,
  hasSuccessfulReplyForReplyId,
  updatePendingAfterReply,
  isDuplicateWechatReply,
  markWechatReplyProcessed,
} = require('./qianfan-data-store');
const { sendQianfanTextReply, findBridgeByShopTitle } = require('./qianfan-ws-bridge');
const { withTimeout } = require('./cdp-timeout');

const QIANFAN_SEND_TOTAL_TIMEOUT_MS = 36000;
const TARGET_LOCK_BLOCK_RECEIPT = '为避免发错买家，本次已拦截，请重新引用对应的待回复通知。';

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

function assertPendingMatchesReply(reply, pending, fromWxid = '') {
  const reasons = [];

  if (!String(pending?.shopTitle || '').trim()) reasons.push('missing_shop_title');
  if (!String(pending?.appCid || '').trim()) reasons.push('missing_app_cid');
  const receiverAppUids = Array.isArray(pending?.receiverAppUids)
    ? pending.receiverAppUids.map((u) => String(u || '').trim()).filter(Boolean)
    : [];
  if (!receiverAppUids.length) reasons.push('missing_receiver_app_uids');
  if (!String(pending?.buyerNick || '').trim()) reasons.push('missing_buyer_nick');

  const quoteText = String(reply?.quoteText || reply?.quote?.quoteText || '').trim();
  if (quoteText) {
    const ctx = parseNoticeContextFromText(quoteText);
    if (ctx.shopTitle && pending.shopTitle) {
      if (normalizeShopKey(ctx.shopTitle) !== normalizeShopKey(pending.shopTitle)) {
        reasons.push('quote_shop_mismatch');
      }
    }
    if (ctx.buyerNick && pending.buyerNick && !buyerNickMatches(ctx.buyerNick, pending.buyerNick)) {
      reasons.push('quote_buyer_mismatch');
    }
    const quoteReplyId = parseReplyIdFromText(quoteText);
    if (quoteReplyId != null && Number(quoteReplyId) !== Number(pending.replyId)) {
      reasons.push('quote_reply_id_mismatch');
    }
  }

  const quotedWxMsgId = String(reply?.quotedWxMsgId || '').trim();
  if (quotedWxMsgId) {
    const mapped = lookupSentNotificationByWxMsgId(quotedWxMsgId);
    if (!mapped) {
      reasons.push('quoted_msg_not_mapped');
    } else {
      const sender = String(fromWxid || '').trim();
      if (mapped.targetWxid && sender && mapped.targetWxid !== sender) {
        reasons.push('quoted_target_wxid_mismatch');
      }
      if (mapped.replyId != null && Number(mapped.replyId) !== Number(pending.replyId)) {
        reasons.push('quoted_reply_id_mismatch');
      }
      if (mapped.appCid && pending.appCid && String(mapped.appCid) !== String(pending.appCid)) {
        reasons.push('quoted_app_cid_mismatch');
      }
    }
  }

  if (reasons.length) {
    return { ok: false, reasons, blockReason: reasons.join(',') };
  }
  return { ok: true, receiverAppUids };
}

async function sendReceiptToNotifyAccount(content, wxid) {
  const target = String(wxid || '').trim() || getAuthorizedReplyWxids()[0] || config.notifyReceiverAccount?.wxid;
  if (!target || config.dryRun) return;
  println(formatWechatSendConsoleLine({ wxid: target, content, label: '二号回执' }));
  await sendWxText(target, content);
}

function formatSuccessReceipt(replyId, pending, text, isAppend, ack = {}) {
  const head = isAppend ? `✅ 已追加回复 #${replyId}` : `✅ 已回复 #${replyId}`;
  const lines = [head, `店铺：${pending.shopTitle}`, `买家：${pending.buyerNick || '买家'}`, `内容：${text}`];
  if (ack.ackConfirmed && ack.echoVerified === false) {
    lines.push('提示：ACK 已成功，但暂未捕获页面回显，请到千帆人工确认是否已发出');
  }
  return lines.join('\n');
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

function formatTargetLockBlockReceipt(replyId, pending) {
  const lines = ['❌ 回复失败'];
  if (replyId) lines.push(`#${replyId}`);
  if (pending?.shopTitle) lines.push(`店铺：${pending.shopTitle}`);
  if (pending?.buyerNick) lines.push(`买家：${pending.buyerNick}`);
  lines.push(TARGET_LOCK_BLOCK_RECEIPT);
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
    debugLog({
      event: 'parsed_reply',
      replyId: reply.replyId || null,
      quotedWxMsgId: reply.quotedWxMsgId || '',
      quoteText: reply.quoteText || '',
      mappedReplyId: reply.mappedReplyId || null,
      source: reply.source || null,
      ok: reply.ok,
      reason: reply.reason || '',
    });

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
      debugLog({ event: 'blocked', replyId, blockReason: 'pending_not_found' });
      try {
        await sendReceiptToNotifyAccount(receipt, parsed.from);
      } catch (err) {
        println(`[错误] 回执发送失败：${err.message || err}`);
      }
      return;
    }

    const validation = assertPendingMatchesReply(reply, pending, parsed.from);
    debugLog({
      event: validation.ok ? 'pre_send_check_ok' : 'blocked',
      replyId,
      quotedWxMsgId: reply.quotedWxMsgId || '',
      quoteText: reply.quoteText || '',
      mappedReplyId: reply.mappedReplyId || null,
      pendingShop: pending.shopTitle || '',
      pendingBuyer: pending.buyerNick || '',
      pendingAppCid: pending.appCid || '',
      receiverAppUids: validation.receiverAppUids || pending.receiverAppUids || [],
      blockReason: validation.blockReason || '',
    });

    if (!validation.ok) {
      println(`[发送前拦截] reason=${validation.blockReason}`);
      try {
        await sendReceiptToNotifyAccount(formatTargetLockBlockReceipt(replyId, pending), parsed.from);
      } catch (err) {
        println(`[错误] 回执发送失败：${err.message || err}`);
      }
      return;
    }

    const receiverAppUids = validation.receiverAppUids;

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

    println(
      `[发送前校验] #${replyId} 店铺=${pending.shopTitle} 买家=${pending.buyerNick || '买家'} appCid=${pending.appCid} receiver=${JSON.stringify(receiverAppUids)} 校验通过`
    );

    const modeLabel = mode === 'quote' || mode === 'quote_text_id' ? '引用' : '#编号';
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
          buyerNick: pending.buyerNick || '',
          strictTarget: true,
        }),
        QIANFAN_SEND_TOTAL_TIMEOUT_MS,
        'sendQianfanTextReply'
      );

      if (!ack?.ackConfirmed) {
        throw new Error('千帆 ACK 未确认，请到千帆手动确认是否已发出');
      }

      markWechatReplyProcessed({ wechatReplyMsgId: wxMsgId, replyId });
      updatePendingAfterReply(replyId);
      appendSentReply({
        replyId,
        wechatReplyMsgId: wxMsgId,
        qianfanMsgId: ack.msgId,
        text: replyText,
        sentAt: Date.now(),
        status: 'sent',
        ackConfirmed: true,
        echoVerified: ack.echoVerified === true,
      });

      println(`[回复] #${replyId} 已发送千帆 msgId=${ack.msgId}`);
      debugLog({
        event: 'sent_ok',
        replyId,
        wxMsgId,
        quotedWxMsgId: reply.quotedWxMsgId || '',
        quoteText: reply.quoteText || '',
        mappedReplyId: reply.mappedReplyId || null,
        pendingShop: pending.shopTitle,
        pendingBuyer: pending.buyerNick,
        pendingAppCid: pending.appCid,
        receiverAppUids,
        qianfanMsgId: ack.msgId,
        text: replyText,
        isAppend,
        echoVerified: ack.echoVerified === true,
      });

      const receipt = formatSuccessReceipt(replyId, pending, replyText, isAppend, ack);
      await sendReceiptToNotifyAccount(receipt, parsed.from);
      println(`[微信] 已发送回复回执：#${replyId}`);
    } catch (err) {
      let reason = String(err.message || err);
      if (/sendQianfanTextReply timeout/i.test(reason)) {
        reason = '千帆发送流程超时，可能 ACK/UI 同步/回显卡住，请到千帆手动确认';
      }
      println(`[错误] #${replyId} 回复失败：${reason}`);
      debugLog({
        event: 'sent_fail',
        replyId,
        quotedWxMsgId: reply.quotedWxMsgId || '',
        quoteText: reply.quoteText || '',
        pendingShop: pending.shopTitle,
        pendingBuyer: pending.buyerNick,
        pendingAppCid: pending.appCid,
        receiverAppUids,
        error: reason,
        text: replyText,
      });

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
  assertPendingMatchesReply,
  TARGET_LOCK_BLOCK_RECEIPT,
};
