/**
 * 千帆发送白名单：仅允许向指定买家昵称发送（默认「饭饭」）
 * 设 sendOnlyBuyerNick 为空字符串可关闭限制（正式对客回复时）
 */
const config = require('./wechat/wxbot-new-config');
const { buyerNickMatches } = require('./qianfan-data-store');
const { println } = require('./utils');

function getSendOnlyBuyerNick() {
  const fromEnv = process.env.QIANFAN_SEND_ONLY_BUYER_NICK;
  if (fromEnv !== undefined) {
    return String(fromEnv).trim();
  }
  const qd = config.qianfanDebug || {};
  if (Object.prototype.hasOwnProperty.call(qd, 'sendOnlyBuyerNick')) {
    return String(qd.sendOnlyBuyerNick || '').trim();
  }
  return '饭饭';
}

function isSendOnlyBuyerNickEnabled() {
  return Boolean(getSendOnlyBuyerNick());
}

function isSendAllowedForBuyer(buyerNick = '') {
  const allowed = getSendOnlyBuyerNick();
  if (!allowed) return true;
  const nick = String(buyerNick || '').trim();
  if (!nick) return false;
  return buyerNickMatches(allowed, nick);
}

function assertSendAllowedForBuyer(buyerNick = '', context = '') {
  const allowed = getSendOnlyBuyerNick();
  if (!allowed) return;

  const nick = String(buyerNick || '').trim();
  if (isSendAllowedForBuyer(nick)) return;

  const suffix = context ? ` (${context})` : '';
  const msg = `[千帆发送] 安全规则：仅允许向「${allowed}」发送消息，当前目标「${nick || '(未知)'}」已拦截${suffix}`;
  println(msg);
  throw new Error(msg);
}

module.exports = {
  getSendOnlyBuyerNick,
  isSendOnlyBuyerNickEnabled,
  isSendAllowedForBuyer,
  assertSendAllowedForBuyer,
};
