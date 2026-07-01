/**
 * 纯协议 IM 发送白名单（测试旁路）：真实发送仅允许「饭饭」
 * 不受 qianfanDebug.sendOnlyBuyerNick 为空的影响；正式对客前勿将此模块用于生产发送。
 */
const { buyerNickMatches } = require('../qianfan-data-store');
const { assertSendAllowedForBuyer, isSendOnlyBuyerNickEnabled } = require('../qianfan-send-guard');

const PROTOCOL_IM_ALLOWED_BUYER = '饭饭';

function isProtocolImSendAllowed(buyerNick = '') {
  const nick = String(buyerNick || '').trim();
  if (!nick) return false;
  return buyerNickMatches(PROTOCOL_IM_ALLOWED_BUYER, nick);
}

function assertProtocolImSendAllowed(buyerNick = '', context = '') {
  if (isSendOnlyBuyerNickEnabled()) {
    assertSendAllowedForBuyer(buyerNick, context || 'protocol_im');
    return;
  }
  if (isProtocolImSendAllowed(buyerNick)) return;
  const suffix = context ? ` (${context})` : '';
  throw new Error(
    `[千帆协议IM] 仅允许向「${PROTOCOL_IM_ALLOWED_BUYER}」发送消息，当前目标「${String(buyerNick || '').trim() || '(未知)'}」已拦截${suffix}`
  );
}

module.exports = {
  PROTOCOL_IM_ALLOWED_BUYER,
  isProtocolImSendAllowed,
  assertProtocolImSendAllowed,
};
