/**
 * 千帆纯协议守护 — 微信通知（复用 wxbot send-text）
 */
const { getLiveNotifyTargets } = require('../wechat/wxbot-new-config');
const { sendWxText } = require('../wechat-send-api');
const { formatOrderInfoForNotice, pickOrderInfoFromMessages } = require('../chat-parse');
const { println } = require('../utils');

function formatTime(ts) {
  const n = Number(ts || Date.now());
  const d = new Date(n > 1e12 ? n : n * 1000);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatBuyerNotice({ shopTitle, buyerNick, text, source, createAt, orderInfo, messages }) {
  const lines = [
    '【千帆新消息】',
    `店铺：${shopTitle || '未知店铺'}`,
    `买家：${buyerNick || '买家'}`,
  ];
  const resolvedOrder = orderInfo || pickOrderInfoFromMessages(messages);
  const orderLines = formatOrderInfoForNotice(resolvedOrder);
  if (orderLines.length) lines.push(...orderLines);
  lines.push(
    `内容：${String(text || '').slice(0, 500)}`,
    `来源：${source || 'WS实时'}`,
    `时间：${formatTime(createAt)}`,
  );
  return lines.join('\n');
}

function formatCredentialExpiredNotice({ shopTitle, reason, channel }) {
  return [
    '【千帆凭证失效】',
    `店铺：${shopTitle || '未知店铺'}`,
    `渠道：${channel || 'WS'}`,
    `原因：${reason || '凭证失效'}`,
    '处理：公司电脑需要重新 tap 刷新配置，或等待 config-agent 自动刷新。',
  ].join('\n');
}

function formatConfigAgentFailureNotice({ failCount, lastError }) {
  return [
    '【千帆配置刷新失败】',
    `连续失败：${failCount} 次`,
    `最近错误：${String(lastError || 'unknown').slice(0, 300)}`,
    '处理：确认千帆客服台已登录，tap:auto 在运行，服务器地址可达。',
  ].join('\n');
}

async function sendDaemonWxNotify(content, options = {}) {
  const text = String(content || '').trim();
  if (!text) return { ok: false, error: 'empty_content' };

  const targets = (options.targets || getLiveNotifyTargets()).filter((t) => t?.wxid);
  if (!targets.length) {
    println('[protocol-daemon] 无微信通知目标，跳过发送');
    return { ok: false, error: 'no_notify_targets' };
  }

  const results = [];
  for (const target of targets) {
    try {
      const row = await sendWxText(target.wxid, text);
      results.push({ wxid: target.wxid, ok: true, wxMsgId: row.wxMsgId });
      println(`[protocol-daemon] 微信通知已发 → ${target.name || target.wxid}`);
    } catch (err) {
      results.push({ wxid: target.wxid, ok: false, error: err.message || String(err) });
      println(`[protocol-daemon] 微信通知失败 → ${target.name || target.wxid}: ${err.message || err}`);
    }
  }
  return { ok: results.some((r) => r.ok), results };
}

module.exports = {
  formatTime,
  formatBuyerNotice,
  formatCredentialExpiredNotice,
  formatConfigAgentFailureNotice,
  sendDaemonWxNotify,
};
