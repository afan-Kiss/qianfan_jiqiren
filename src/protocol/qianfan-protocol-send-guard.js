/**
 * 纯协议 IM 发送校验：仅当配置了 sendOnlyBuyerNick 时才限制目标买家
 */
const { assertSendAllowedForBuyer, isSendAllowedForBuyer, isSendOnlyBuyerNickEnabled } = require('../qianfan-send-guard');

function isProtocolImSendAllowed(buyerNick = '') {
  return isSendAllowedForBuyer(buyerNick);
}

function assertProtocolImSendAllowed(buyerNick = '', context = '') {
  assertSendAllowedForBuyer(buyerNick, context || 'protocol_im');
}

function isProtocolBridgeProductionEnabled() {
  const v = String(process.env.QIANFAN_PROTOCOL_BRIDGE_PRODUCTION || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function assertProtocolBridgeSendAllowed(buyerNick = '', context = '') {
  assertSendAllowedForBuyer(buyerNick, context || 'protocol_bridge');
}

module.exports = {
  isProtocolImSendAllowed,
  assertProtocolImSendAllowed,
  isProtocolBridgeProductionEnabled,
  assertProtocolBridgeSendAllowed,
};
