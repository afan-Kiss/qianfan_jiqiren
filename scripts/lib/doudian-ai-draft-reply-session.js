const path = require('path');
const fs = require('fs');
const {
  getLatestCapturedConversation,
  getRecentConversationMessages,
  insertReplyDraft,
  closeDb,
} = require('../../src/platforms/doudian/doudian-data-store');
const {
  buildDraftContext,
  generateDraftFromContext,
} = require('../../src/platforms/doudian/doudian-ai-draft-generator');

const PHONE_RE = /1\d{10}/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const ORDER_RE = /\b\d{12,22}\b/g;

function maskTextForReport(text = '') {
  return String(text || '')
    .replace(PHONE_RE, (m) => `${m.slice(0, 3)}****${m.slice(-4)}`)
    .replace(EMAIL_RE, (m) => `${m.slice(0, 2)}***@***`)
    .replace(ORDER_RE, (m) => `${m.slice(0, 4)}***${m.slice(-4)}`);
}

function resolveDbPath(options = {}) {
  if (options.dbPath) return options.dbPath;
  if (process.env.DOUDIAN_VERIFY_DB) return process.env.DOUDIAN_VERIFY_DB;

  const candidates = [
    path.join(process.cwd(), 'logs', 'doudian-chat-history-guided.db'),
    path.join(process.cwd(), 'logs', 'doudian-chat-history.db'),
    path.join(process.cwd(), 'logs', 'doudian-chat-history-mock.db'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function buildDraftTextReport(report) {
  const lines = [];
  lines.push('=== 抖店 AI 客服回复草稿报告 ===');
  lines.push(`时间: ${report.finishedAt || new Date().toISOString()}`);
  lines.push(`结果: ${report.success ? '成功' : '失败'}`);
  lines.push(`reason: ${report.reason || ''}`);
  lines.push(`platform: ${report.platform || 'doudian'}`);
  lines.push(`shopId: ${report.shopId || ''}`);
  lines.push(`shopName: ${report.shopName || ''}`);
  lines.push(`conversationId: ${report.conversationId ? `${String(report.conversationId).slice(0, 12)}***` : ''}`);
  lines.push(`buyerId: ${report.buyerId ? `${String(report.buyerId).slice(0, 4)}***` : ''}`);
  lines.push(`buyerName: ${report.buyerName || ''}`);
  lines.push(`messageCount: ${report.messageCount ?? 0}`);
  lines.push(`lastBuyerMessage: ${report.lastBuyerMessage || ''}`);
  lines.push(`draftText: ${report.draftText || ''}`);
  lines.push(`draftReason: ${report.draftReason || ''}`);
  lines.push(`riskLevel: ${report.riskLevel || ''}`);
  lines.push(`status: ${report.status || ''}`);
  lines.push(`draftId: ${report.draftId ?? 0}`);
  lines.push(`dbPath: ${report.dbPath ? path.basename(report.dbPath) : ''}`);
  if (report.warnings?.length) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  if (report.errors?.length) {
    lines.push('');
    lines.push('Errors:');
    for (const e of report.errors) lines.push(`- ${e}`);
  }
  if (report.nextActions?.length) {
    lines.push('');
    lines.push('Next actions:');
    for (const a of report.nextActions) lines.push(`- ${a}`);
  }
  return lines;
}

function runAiDraftReplySession(options = {}) {
  const startedAt = Date.now();
  const report = {
    success: false,
    reason: '',
    platform: 'doudian',
    shopId: '',
    shopName: '',
    conversationId: '',
    buyerId: '',
    buyerName: '',
    messageCount: 0,
    lastBuyerMessage: '',
    draftText: '',
    draftReason: '',
    riskLevel: '',
    status: '',
    draftId: 0,
    dbPath: '',
    warnings: [],
    errors: [],
    nextActions: [],
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: '',
    durationMs: 0,
  };

  const dbPath = resolveDbPath(options);
  if (!dbPath) {
    report.reason = 'no_conversation_messages';
    report.errors.push('未找到可用的 SQLite 历史库，请先运行 guided 历史捕获');
    report.nextActions = [
      '运行 npm run doudian:verify-chat-history-guided 捕获历史消息',
    ];
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeReportForOutput(report);
  }

  report.dbPath = dbPath;
  process.env.DOUDIAN_VERIFY_DB = dbPath;
  closeDb();

  const conversation = getLatestCapturedConversation({ platform: 'doudian' });
  if (!conversation) {
    report.reason = 'no_conversation_messages';
    report.errors.push('platform_messages 中无可用会话');
    report.nextActions = [
      '运行 npm run doudian:verify-chat-history-guided 捕获历史消息',
    ];
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeReportForOutput(report);
  }

  const rawMessages = getRecentConversationMessages(conversation.conversation_id, {
    platform: 'doudian',
    limit: 20,
  });

  const context = buildDraftContext(
    {
      platform: conversation.platform,
      shopId: conversation.shop_id,
      shopName: conversation.shop_name,
      conversationId: conversation.conversation_id,
      buyerId: conversation.buyer_id,
      buyerName: conversation.buyer_name,
    },
    rawMessages
  );

  report.shopId = context.shopId;
  report.shopName = context.shopName;
  report.conversationId = context.conversationId;
  report.buyerId = context.buyerId;
  report.buyerName = context.buyerName;
  report.messageCount = context.messages.length;

  const generated = generateDraftFromContext(context);
  report.lastBuyerMessage = maskTextForReport(generated.lastBuyerMessage || '');

  if (!generated.ok) {
    report.reason = generated.reason;
    if (generated.reason === 'no_reply_needed') {
      report.warnings.push('最后一条消息不是买家消息，无需生成回复草稿');
      report.nextActions = ['等待买家新消息后再运行 ai-draft-reply'];
    } else if (generated.reason === 'risk_blocked') {
      report.draftText = maskTextForReport(generated.draftText || '');
      report.draftReason = generated.draftReason || '';
      report.riskLevel = 'high';
      report.status = 'risk_blocked';
      const inserted = insertReplyDraft({
        platform: context.platform,
        shopId: context.shopId,
        shopName: context.shopName,
        conversationId: context.conversationId,
        buyerId: context.buyerId,
        buyerName: context.buyerName,
        lastBuyerMessage: generated.lastBuyerMessage || '',
        draftText: generated.draftText || '',
        draftReason: generated.draftReason || '',
        riskLevel: 'high',
        status: 'risk_blocked',
        source: 'rule_generator',
      });
      report.draftId = inserted.id;
      report.warnings.push('草稿命中风险词，已拦截，不会进入可用状态');
    } else {
      report.nextActions = [
        '确认 platform_messages 中有买家方向消息',
        '运行 npm run doudian:verify-chat-history-guided 重新捕获',
      ];
    }
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    return sanitizeReportForOutput(report);
  }

  const inserted = insertReplyDraft({
    platform: context.platform,
    shopId: context.shopId,
    shopName: context.shopName,
    conversationId: context.conversationId,
    buyerId: context.buyerId,
    buyerName: context.buyerName,
    lastBuyerMessage: generated.lastBuyerMessage || '',
    draftText: generated.draftText || '',
    draftReason: generated.draftReason || '',
    riskLevel: generated.riskLevel || 'low',
    status: 'draft_only',
    source: 'rule_generator',
  });

  report.success = true;
  report.reason = 'draft_generated';
  report.draftText = maskTextForReport(generated.draftText || '');
  report.draftReason = generated.draftReason || '';
  report.riskLevel = generated.riskLevel || 'low';
  report.status = 'draft_only';
  report.draftId = inserted.id;
  report.nextActions = [
    '草稿已写入 platform_reply_drafts，status=draft_only',
    '人工审核后可决定是否发送（本阶段禁止自动发送）',
    '再次运行可基于最新买家消息生成新草稿',
  ];
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  return sanitizeReportForOutput(report);
}

function sanitizeReportForOutput(report) {
  return {
    ...report,
    conversationId: report.conversationId
      ? `${String(report.conversationId).slice(0, 16)}***`
      : '',
    buyerId: report.buyerId ? `${String(report.buyerId).slice(0, 4)}***` : '',
    dbPath: report.dbPath ? path.basename(report.dbPath) : '',
  };
}

module.exports = {
  runAiDraftReplySession,
  buildDraftTextReport,
  maskTextForReport,
  resolveDbPath,
};
