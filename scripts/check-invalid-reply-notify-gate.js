const assert = require('assert');
const {
  shouldNotifyInvalidReply,
  formatInvalidReplyReason,
} = require('../src/wechat-reply-parser');

function main() {
  assert.strictEqual(
    shouldNotifyInvalidReply({ authorized: true, reason: 'no_reply_id', rawText: '早上好', quote: {} }),
    false,
    '普通聊天不应触发失败回执',
  );
  assert.strictEqual(
    shouldNotifyInvalidReply({
      authorized: true,
      reason: 'no_reply_id',
      rawText: '',
      quote: { quotedMsgId: 'wx-msg-1', quoteText: '【千帆待回复 #1205】' },
    }),
    true,
    '引用待回复但解析失败仍应提示',
  );
  assert.strictEqual(
    shouldNotifyInvalidReply({ authorized: true, reason: 'quote_map_miss', rawText: '好的', quote: {} }),
    true,
  );
  assert.strictEqual(
    formatInvalidReplyReason('no_reply_id'),
    '没有识别到引用通知或 #编号',
  );

  console.log('[check-invalid-reply-notify-gate] passed');
}

main();
