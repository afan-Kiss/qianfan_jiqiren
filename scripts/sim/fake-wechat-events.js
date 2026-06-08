module.exports = {
  buildWechatReplyEvent({ replyId, text, fromWxid, wxMsgId }) {
    return {
      parsed: {
        from: fromWxid,
        wxMsgId: wxMsgId || `sim-wx-${Date.now()}`,
        content: text || `#${replyId} 模拟回复`,
      },
      body: {},
    };
  },
};
