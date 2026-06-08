const WORKER_LABELS = {
  supervisor: '调度器',
  'qianfan-listener': '千帆监听',
  'qianfan-sender': '千帆发送',
  'wechat-callback': '微信回调',
  'wechat-notifier': '微信通知',
  'wechat-reply': '微信回复',
  persistence: '持久化',
};

function formatActivityLogEntry(entry = {}) {
  if (!entry.userFacing) {
    return { show: false, text: '', dedupKey: '', time: entry.time || Date.now() };
  }

  const text = String(entry.message || entry.text || '').trim();
  if (!text) {
    return { show: false, text: '', dedupKey: '', time: entry.time || Date.now() };
  }

  if (/看门狗已喂食|看门狗已喂|watchdog feed|worker heartbeat|心跳正常|健康检查正常/i.test(text)) {
    return { show: false, text: '', dedupKey: '', time: entry.time || Date.now() };
  }

  const dedupKey = String(entry.dedupKey || text).trim().slice(0, 160);
  return {
    show: true,
    text: text.slice(0, 200),
    dedupKey,
    time: entry.time || Date.now(),
  };
}

function buildActivityDedupKey(entry = {}) {
  const formatted = formatActivityLogEntry(entry);
  if (formatted.dedupKey) return formatted.dedupKey;
  const message = String(entry.message || entry.text || '').trim();
  const workerName = entry.workerName || '';
  return `${workerName}:${entry.level || 'info'}:${message}`;
}

function shouldHideActivity() {
  return true;
}

function translateMessage(message) {
  return String(message || '').trim();
}

module.exports = {
  WORKER_LABELS,
  formatActivityLogEntry,
  buildActivityDedupKey,
  translateMessage,
  shouldHideActivity,
};
