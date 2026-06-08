const path = require('path');
const fs = require('fs');
const config = require('../src/wechat/wxbot-new-config');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  process.env.QIANFAN_DISTRIBUTED_RUNTIME = '1';
  const testDataDir = path.join(ROOT, 'data', 'test-runtime', `dead-letter-${Date.now()}`);
  fs.mkdirSync(testDataDir, { recursive: true });
  process.env.QIANFAN_SIM_DATA_DIR = testDataDir;

  delete require.cache[require.resolve('../src/adapters/legacy-data-store-adapter')];
  delete require.cache[require.resolve('../src/adapters/legacy-wechat-reply-adapter')];
  const { executeAction } = require('../src/adapters/legacy-data-store-adapter');
  const { parseWechatReplyContent } = require('../src/adapters/legacy-wechat-reply-adapter');

  const authorizedWxid = config.authorizedReplyWxid || config.notifyReceiverAccount?.wxid;
  const missingReplyId = 99099;
  const wxMsgId = `wx-dead-letter-${Date.now()}`;

  const dedup = await executeAction('wechatReply.ensureDedup', {
    wechatReplyMsgId: wxMsgId,
    replyId: missingReplyId,
    fromWxid: authorizedWxid,
    text: 'missing pending test',
  });
  if (!dedup.ok || dedup.data?.duplicate) throw new Error('should not be duplicate');

  const parseResult = await parseWechatReplyContent({
    parsed: {
      from: authorizedWxid,
      wxMsgId,
      content: `#${missingReplyId} 找不到 pending`,
    },
    body: {},
  });
  if (!parseResult.ok || parseResult.data?.kind !== 'parsed_reply') {
    throw new Error('parse should succeed for authorized reply');
  }

  const pendingGet = await executeAction('pendingReply.get', { replyId: missingReplyId });
  if (pendingGet.data?.pending) throw new Error('pending should be missing for this test');

  const deadLetterResult = await executeAction('deadLetter.record', {
    traceId: 'dead-letter-test',
    topic: 'wechat.reply.received',
    workerName: 'wechat-reply',
    reason: 'pending_reply_not_found',
    payload: { replyId: missingReplyId },
  });
  if (!deadLetterResult.ok) throw new Error('deadLetter.record failed');

  const deadLetterFile = path.join(testDataDir, 'dead-letters.json');
  const deadLetters = JSON.parse(fs.readFileSync(deadLetterFile, 'utf8'));
  const found = deadLetters.some(
    (item) => item.reason === 'pending_reply_not_found' && item.payload?.replyId === missingReplyId,
  );
  if (!found) throw new Error('dead letter entry not found in data store');

  const logsDir = path.join(ROOT, 'logs');
  const logFiles = fs.readdirSync(logsDir).filter((f) => f.startsWith('dead-letter-') && f.endsWith('.log'));
  if (!logFiles.length) throw new Error('dead letter log file missing');

  fs.rmSync(testDataDir, { recursive: true, force: true });
  delete process.env.QIANFAN_SIM_DATA_DIR;
  delete process.env.QIANFAN_DISTRIBUTED_RUNTIME;
  console.log('[check-dead-letter] OK');
}

main().catch((err) => {
  delete process.env.QIANFAN_SIM_DATA_DIR;
  delete process.env.QIANFAN_DISTRIBUTED_RUNTIME;
  console.error('[check-dead-letter] FAILED');
  console.error(err.message || err);
  process.exit(1);
});
