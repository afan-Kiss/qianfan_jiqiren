const { WORKER_LABELS } = require('./activity-log');
const config = require('../wechat/wxbot-new-config');
const { getLiveNotifyTargets } = config;

const RESTART_REASON_LABELS = {
  crashed: '进程异常退出',
  timeout: '心跳超时',
  start_failed: '启动失败',
  manual: '手动操作',
};

const WORKER_STATUS_LABELS = {
  running: '运行正常',
  starting: '正在启动',
  restarting: '正在重启',
  stopping: '正在停止',
  stopped: '已停止',
  failed: '已失败',
  degraded: '运行异常',
  timeout: '心跳超时',
};

function formatLogTime(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

function formatRestartReason(reason = '') {
  return RESTART_REASON_LABELS[reason] || '自动恢复';
}

function workerStatusText(worker = {}) {
  const status = worker.status || 'stopped';
  if (status === 'running') return WORKER_STATUS_LABELS.running;
  if (status === 'degraded' || status === 'failed') {
    const err = String(worker.lastError || worker.reason || '').trim();
    if (err && !/[a-z]{4,}/i.test(err)) return err;
    if (err) return WORKER_STATUS_LABELS[status];
    return WORKER_STATUS_LABELS[status];
  }
  return WORKER_STATUS_LABELS[status] || status;
}

function formatShopSummary(shopReport = null) {
  const shops = Array.isArray(shopReport?.shops) ? shopReport.shops : [];
  if (!shops.length) return '';
  const names = shops
    .map((shop) => String(shop.shopTitle || shop.pageTitle || '').trim())
    .filter(Boolean);
  if (!names.length) return `已连接 ${shops.length} 个店铺`;
  return `已连接 ${names.length} 个店铺（${names.join('、')}）`;
}

function buildUserHeartbeatSummary(runtimeStatus = {}) {
  const workers = runtimeStatus.workers || [];
  const byName = Object.fromEntries(workers.map((w) => [w.workerName, w]));
  const parts = [];

  const callback = byName['wechat-callback'];
  if (callback) {
    parts.push(`微信${callback.status === 'running' ? '连接正常' : workerStatusText(callback)}`);
  }

  const listener = byName['qianfan-listener'];
  if (listener) {
    if (listener.qianfanReady && listener.listenerReady) {
      const shopText = formatShopSummary(listener.shopReport);
      parts.push(shopText ? `千帆${shopText}，监听正常` : '千帆已连接，监听正常');
    } else {
      const hint = String(listener.lastError || listener.reason || '未就绪').trim();
      parts.push(hint && !/[a-z]{5,}/i.test(hint) ? `千帆：${hint}` : '千帆：未就绪');
    }
  }

  for (const workerName of ['wechat-notifier', 'wechat-reply', 'qianfan-sender', 'persistence']) {
    const worker = byName[workerName];
    if (!worker) continue;
    const label = WORKER_LABELS[workerName] || workerName;
    parts.push(`${label}：${workerStatusText(worker)}`);
  }

  return parts.join('；');
}

function buildWorkerModulesSummary(runtimeStatus = {}) {
  const workers = runtimeStatus.workers || [];
  return workers
    .filter((w) => w.workerName && w.workerName !== 'supervisor')
    .map((w) => {
      const label = WORKER_LABELS[w.workerName] || w.workerName;
      return `${label}：${workerStatusText(w)}`;
    })
    .join('；');
}

function clipText(text, max = 48) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function resolveNotifierLabel(wxid) {
  const id = String(wxid || '').trim();
  if (!id) return '未知通知人';
  for (const target of getLiveNotifyTargets()) {
    if (String(target.wxid || '').trim() !== id) continue;
    const name = String(target.name || '').trim();
    const wechatNo = String(target.wechatNo || '').trim();
    if (name && name !== id) {
      return wechatNo ? `${name}（${wechatNo}）` : `${name}（${id}）`;
    }
    if (wechatNo) return `${wechatNo}（${id}）`;
    return id;
  }
  return id;
}

function formatNotifierTargets(wxids = []) {
  const ids = [...new Set((wxids || []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!ids.length) return '通知人';
  return ids.map(resolveNotifierLabel).join('、');
}

function formatBuyerContext(source = {}) {
  const shop = String(source.shopTitle || '').trim() || '未知店铺';
  const buyer = String(source.buyerNick || '').trim() || '买家';
  return { shop, buyer, label: `店铺「${shop}」买家「${buyer}」` };
}

function formatNotifySuccessMessage({ replyId, message, targets, sentMessages }) {
  const { label } = formatBuyerContext(message || {});
  const wxids = (sentMessages || []).map((item) => item.wxid).filter(Boolean);
  const notifierText = formatNotifierTargets(wxids.length ? wxids : targets);
  return `已通知微信 #${replyId}：${label} → ${notifierText}`;
}

function formatNotifyPartialMessage({ replyId, message, targets, sentMessages, failedTargets }) {
  const { label } = formatBuyerContext(message || {});
  const okText = formatNotifierTargets(
    (sentMessages || []).map((item) => item.wxid).filter(Boolean).length
      ? (sentMessages || []).map((item) => item.wxid)
      : targets,
  );
  const failText = formatNotifierTargets(failedTargets || []);
  if (failText && failText !== '通知人') {
    return `部分通知 #${replyId}：${label} · 已成功 ${okText} · 待补发 ${failText}`;
  }
  return `部分通知 #${replyId}：${label} · 已成功 ${okText}，系统将自动补发`;
}

function formatReplySuccessMessage({ replyId, fromWxid, pending, replyText }) {
  const { label } = formatBuyerContext(pending || {});
  const notifier = resolveNotifierLabel(fromWxid);
  const content = clipText(replyText, 40);
  if (!content) {
    return `${notifier} 已成功回复千帆 #${replyId}：${label}`;
  }
  return `${notifier} 已成功回复千帆 #${replyId}：${label} · ${content}`;
}

function formatReplyFailureMessage({ replyId, fromWxid, pending, reason }) {
  const { label } = formatBuyerContext(pending || {});
  const notifier = resolveNotifierLabel(fromWxid);
  const err = clipText(reason || '发送失败', 56);
  return `${notifier} 回复千帆失败 #${replyId || ''}：${label} · ${err}`.replace(/ #：/, '：');
}

module.exports = {
  formatLogTime,
  formatRestartReason,
  workerStatusText,
  formatShopSummary,
  buildUserHeartbeatSummary,
  buildWorkerModulesSummary,
  WORKER_STATUS_LABELS,
  resolveNotifierLabel,
  formatNotifySuccessMessage,
  formatNotifyPartialMessage,
  formatReplySuccessMessage,
  formatReplyFailureMessage,
};
