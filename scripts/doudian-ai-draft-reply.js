#!/usr/bin/env node
/**
 * 抖店 AI 客服回复草稿（仅生成，不发送）
 * npm run doudian:ai-draft-reply
 */
const { writeReports } = require('./lib/auto-verify-utils');
const {
  runAiDraftReplySession,
  buildDraftTextReport,
} = require('./lib/doudian-ai-draft-reply-session');

function main() {
  console.log('=== 抖店 AI 客服回复草稿 ===');
  console.log('本命令仅生成草稿并写入 SQLite，不会发送任何客服消息');

  const report = runAiDraftReplySession();
  const paths = writeReports(report, {
    prefix: 'doudian-ai-draft-reply',
    buildTextReport: buildDraftTextReport,
  });

  console.log('\n' + buildDraftTextReport(report).join('\n'));
  console.log(`\nJSON: ${paths.jsonLatest}`);
  console.log(`TXT:  ${paths.txtLatest}`);

  process.exit(report.success ? 0 : 1);
}

main();
