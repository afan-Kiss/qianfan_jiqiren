const config = require('../wechat/wxbot-new-config');
const { isAuthorizedReplyWxid } = config;
const {
  parseAuthorizedWechatReply,
  parseRobotNotificationForMap,
} = require('../wechat-reply-parser');
const { recordSentNotification } = require('../qianfan-data-store');
const { ok, fail } = require('./adapter-result');

const isDistributed = () => process.env.QIANFAN_DISTRIBUTED_RUNTIME === '1';

async function parseWechatReplyContent({ parsed, body }) {
  try {
    const mapEntry = parseRobotNotificationForMap(parsed, body);
    if (mapEntry && !isDistributed()) {
      recordSentNotification(mapEntry);
    } else if (mapEntry) {
      return ok({ kind: 'notification_map', mapEntry });
    }

    if (!isAuthorizedReplyWxid(parsed.from)) {
      return ok({ kind: 'ignored', reason: 'not_authorized_sender' });
    }

    const reply = parseAuthorizedWechatReply(parsed, body);
    if (!reply.ok) {
      return ok({ kind: 'invalid_reply', reply });
    }

    const wxMsgId = reply.wxMsgId || parsed.wxMsgId || parsed.msgId || '';
    return ok({
      kind: 'parsed_reply',
      reply: {
        replyId: reply.replyId,
        text: reply.replyText || reply.text,
        mode: reply.mode,
        wxMsgId,
        fromWxid: parsed.from,
        quotedWxMsgId: reply.quotedWxMsgId || '',
        quoteText: reply.quote?.quoteText || '',
        reason: reply.reason,
      },
    });
  } catch (err) {
    return fail(err, 'WECHAT_REPLY_PARSE_FAILED');
  }
}

async function parseWechatReplyEvent({ parsed, body }) {
  if (isDistributed()) {
    return parseWechatReplyContent({ parsed, body });
  }

  const dataStore = require('../qianfan-data-store');
  try {
    const mapEntry = parseRobotNotificationForMap(parsed, body);
    if (mapEntry) {
      recordSentNotification(mapEntry);
    }

    if (!isAuthorizedReplyWxid(parsed.from)) {
      return ok({ kind: 'ignored', reason: 'not_authorized_sender' });
    }

    const reply = parseAuthorizedWechatReply(parsed, body);
    if (!reply.ok) {
      return ok({ kind: 'invalid_reply', reply });
    }

    const wxMsgId = reply.wxMsgId || parsed.wxMsgId || parsed.msgId || '';
    if (dataStore.isDuplicateWechatReply({ wechatReplyMsgId: wxMsgId, replyId: reply.replyId })) {
      return ok({ kind: 'duplicate', replyId: reply.replyId });
    }

    const pending = dataStore.resolvePendingReply({
      replyId: reply.replyId,
      fromWxid: parsed.from,
      quotedWxMsgId: reply.quotedWxMsgId,
      wxMsgId,
    });
    if (!pending) {
      return ok({ kind: 'pending_not_found', replyId: reply.replyId, reply });
    }

    let receiverAppUids = Array.isArray(pending.receiverAppUids)
      ? pending.receiverAppUids.filter(Boolean)
      : [];
    if (!receiverAppUids.length) {
      receiverAppUids = dataStore.getReceiverAppUids(pending.shopTitle, pending.appCid);
    }

    return ok({
      kind: 'send_request',
      request: {
        replyId: reply.replyId,
        replyText: reply.text,
        mode: reply.mode,
        wxMsgId,
        pending,
        receiverAppUids,
        fromWxid: parsed.from,
      },
    });
  } catch (err) {
    return fail(err, 'WECHAT_REPLY_PARSE_FAILED');
  }
}

module.exports = {
  parseWechatReplyEvent,
  parseWechatReplyContent,
};
