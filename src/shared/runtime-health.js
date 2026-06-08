const LEVEL = {
  normal: 'normal',
  warning: 'warning',
  error: 'error',
  unknown: 'unknown',
};

const LEVEL_RANK = {
  unknown: 0,
  normal: 1,
  warning: 2,
  error: 3,
};

function worstLevel(...levels) {
  return levels.reduce((best, level) => (
    LEVEL_RANK[level] > LEVEL_RANK[best] ? level : best
  ), LEVEL.unknown);
}

function formatClock(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts) || Date.now());
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  const second = String(d.getSeconds()).padStart(2, '0');
  return `${hour}:${minute}:${second}`;
}

function formatAgeSec(ageMs) {
  if (ageMs == null || !Number.isFinite(ageMs)) return '';
  const sec = Math.max(0, Math.floor(ageMs / 1000));
  return `${sec} 秒前`;
}

function levelToProgressStatus(level) {
  if (level === LEVEL.normal) return 'done';
  if (level === LEVEL.warning) return 'warn';
  if (level === LEVEL.error) return 'error';
  return 'unknown';
}

function computeWatchdogHealth(lastWatchdogFeedAt, now = Date.now()) {
  if (!lastWatchdogFeedAt) {
    return {
      level: LEVEL.unknown,
      watchdogStatus: 'unknown',
      watchdogAgeMs: null,
      label: '● worker 等待心跳',
    };
  }

  const ageMs = now - lastWatchdogFeedAt;
  if (ageMs <= 90000) {
    return {
      level: LEVEL.normal,
      watchdogStatus: 'normal',
      watchdogAgeMs: ageMs,
      label: `● worker 正常 · 看门狗 ${formatAgeSec(ageMs)} ✓`,
      showCheck: true,
    };
  }
  if (ageMs <= 150000) {
    return {
      level: LEVEL.warning,
      watchdogStatus: 'delayed',
      watchdogAgeMs: ageMs,
      label: `● worker 心跳延迟 · 上次看门狗 ${formatAgeSec(ageMs)}`,
    };
  }
  return {
    level: LEVEL.error,
    watchdogStatus: 'timeout',
    watchdogAgeMs: ageMs,
    label: `● worker 心跳超时 · 上次看门狗 ${formatAgeSec(ageMs)} !`,
  };
}

function computeQianfanHealth(snapshot, now = Date.now()) {
  const {
    relayRunning,
    qianfanReady,
    listenerReady,
    listener = {},
  } = snapshot;

  const phase = listener.phase || listener.qianfanRuntime?.phase || '';
  const lastError = String(listener.lastError || listener.reason || listener.qianfanRuntime?.lastError || '');
  const checkedAt = listener.lastStatusAt || listener.qianfanRuntime?.lastReadyAt || now;

  if (!relayRunning) {
    return {
      level: LEVEL.unknown,
      qianfanStatus: 'unknown',
      label: '● 千帆等待连接',
      checkedAt: null,
    };
  }

  if (qianfanReady && listenerReady) {
    return {
      level: LEVEL.normal,
      qianfanStatus: 'normal',
      label: `● 千帆已连接，最近检查：${formatClock(checkedAt)} ✓`,
      showCheck: true,
      checkedAt,
    };
  }

  if (listener.status === 'failed' || phase === 'failed') {
    const detail = /CDP|devtools|调试端口/i.test(lastError)
      ? 'CDP 未连接'
      : (lastError.slice(0, 24) || '监听不可用');
    return {
      level: LEVEL.error,
      qianfanStatus: 'error',
      label: `● 千帆连接异常：${detail} !`,
      checkedAt,
    };
  }

  if (
    ['launching', 'checking', 'waiting_shops', 'waiting_launch', 'starting', 'qianfan_ready', 'attached'].includes(phase)
    || (listener.qianfanReady && !listenerReady)
    || listener.status === 'starting'
    || listener.status === 'degraded'
  ) {
    const label = phase === 'waiting_shops'
      ? '● 千帆连接不稳定：等待店铺页面'
      : '● 千帆连接不稳定：正在重连';
    return {
      level: LEVEL.warning,
      qianfanStatus: 'warning',
      label,
      checkedAt,
    };
  }

  if (/CDP|devtools|监听|未连接|不可用/i.test(lastError)) {
    return {
      level: LEVEL.error,
      qianfanStatus: 'error',
      label: '● 千帆连接异常：CDP 未连接 !',
      checkedAt,
    };
  }

  return {
    level: LEVEL.error,
    qianfanStatus: 'error',
    label: '● 千帆连接异常：未连接 !',
    checkedAt,
  };
}

function computeWechatHealth(snapshot, now = Date.now()) {
  const {
    relayRunning,
    wechatReady,
    callback = {},
    notifier = {},
    notifyAccountCount = 0,
  } = snapshot;

  const checkedAt = callback.lastHeartbeatAt || callback.lastStatusAt || now;

  if (!relayRunning) {
    return {
      level: LEVEL.unknown,
      wechatStatus: 'unknown',
      label: '● 微信等待初始化',
      checkedAt: null,
    };
  }

  if (wechatReady && notifyAccountCount > 0 && notifier.status === 'running') {
    return {
      level: LEVEL.normal,
      wechatStatus: 'normal',
      label: `● 微信已就绪，最近检查：${formatClock(checkedAt)} ✓`,
      showCheck: true,
      checkedAt,
    };
  }

  if (wechatReady && notifyAccountCount === 0) {
    return {
      level: LEVEL.warning,
      wechatStatus: 'warning',
      label: '● 微信状态不稳定：未设置通知人',
      checkedAt,
    };
  }

  if (callback.status === 'failed' || callback.status === 'timeout' || notifier.status === 'failed') {
    return {
      level: LEVEL.error,
      wechatStatus: 'error',
      label: '● 微信异常：通知发送不可用 !',
      checkedAt,
    };
  }

  if (['starting', 'degraded', 'restarting'].includes(callback.status) || !wechatReady) {
    return {
      level: LEVEL.warning,
      wechatStatus: 'warning',
      label: '● 微信状态不稳定：正在检查',
      checkedAt,
    };
  }

  return {
    level: LEVEL.error,
    wechatStatus: 'error',
    label: '● 微信异常：未就绪 !',
    checkedAt,
  };
}

function computeRelayHealth(snapshot, watchdogHealth) {
  const {
    relayRunning,
    supervisorStatus,
    qianfanReady,
    listenerReady,
    wechatReady,
    workers = [],
  } = snapshot;

  if (!relayRunning) {
    return {
      level: LEVEL.unknown,
      relayStatus: 'unknown',
      label: '● 中转未启动',
    };
  }

  const coreWorkers = ['qianfan-listener', 'wechat-notifier', 'wechat-callback'];
  const coreFailed = workers.some((worker) => (
    coreWorkers.includes(worker.workerName)
    && (worker.status === 'failed' || worker.status === 'timeout')
  ));

  if (coreFailed || watchdogHealth.level === LEVEL.error) {
    return {
      level: LEVEL.error,
      relayStatus: 'error',
      label: '● 中转异常：worker 可能卡死 !',
    };
  }

  if (
    supervisorStatus === 'running'
    && qianfanReady
    && listenerReady
    && wechatReady
    && watchdogHealth.level === LEVEL.normal
  ) {
    return {
      level: LEVEL.normal,
      relayStatus: 'normal',
      label: '● 中转运行中，消息链路正常 ✓',
      showCheck: true,
    };
  }

  if (supervisorStatus === 'degraded' || watchdogHealth.level === LEVEL.warning) {
    return {
      level: LEVEL.warning,
      relayStatus: 'warning',
      label: '● 中转运行中，但状态延迟',
    };
  }

  return {
    level: LEVEL.warning,
    relayStatus: 'warning',
    label: '● 中转运行中，但状态延迟',
  };
}

function computeOverallHealth(sections, snapshot, now = Date.now()) {
  const levels = [sections.qianfan, sections.wechat, sections.relay, sections.worker];
  const worst = worstLevel(...levels.map((item) => item.level));

  if (!snapshot.relayRunning) {
    return {
      level: LEVEL.unknown,
      overallStatus: 'unknown',
      title: '中转未启动',
      heroState: 'stopped',
      subtitle: '点击下方按钮开始中转',
    };
  }

  if (worst === LEVEL.error) {
    const parts = [];
    if (sections.qianfan.level === LEVEL.error) parts.push('千帆连接异常');
    if (sections.wechat.level === LEVEL.error) parts.push('微信异常');
    if (sections.relay.level === LEVEL.error || sections.worker.level === LEVEL.error) parts.push('worker 超时');
    return {
      level: LEVEL.error,
      overallStatus: 'error',
      title: `中转异常 · ${parts[0] || '部分模块异常'}`,
      heroState: 'error',
      subtitle: parts.join(' / ') || '请查看当前进度',
    };
  }

  if (worst === LEVEL.warning) {
    let hint = '部分状态异常';
    if (sections.worker.level === LEVEL.warning) hint = '看门狗延迟';
    else if (sections.qianfan.level === LEVEL.warning) hint = '千帆连接不稳定';
    else if (sections.wechat.level === LEVEL.warning) hint = '微信状态不稳定';
    return {
      level: LEVEL.warning,
      overallStatus: 'warning',
      title: `中转运行中 · 部分状态异常 · ${hint}`,
      heroState: 'attention',
      subtitle: '正在恢复，请稍候',
    };
  }

  return {
    level: LEVEL.normal,
    overallStatus: 'normal',
    title: `中转运行中 · 全部正常 · ${formatClock(now)}`,
    heroState: 'running',
    subtitle: '正在帮你转发消息',
  };
}

function buildProgressLines(sections) {
  return [
    { key: 'qianfan', text: sections.qianfan.label, status: levelToProgressStatus(sections.qianfan.level), showCheck: sections.qianfan.showCheck === true },
    { key: 'wechat', text: sections.wechat.label, status: levelToProgressStatus(sections.wechat.level), showCheck: sections.wechat.showCheck === true },
    { key: 'relay', text: sections.relay.label, status: levelToProgressStatus(sections.relay.level), showCheck: sections.relay.showCheck === true },
    { key: 'worker', text: sections.worker.label, status: levelToProgressStatus(sections.worker.level), showCheck: sections.worker.showCheck === true },
  ];
}

function computeRuntimeHealth(rawStatus = {}, options = {}) {
  const now = Number(options.now) || Date.now();
  const workers = Array.isArray(rawStatus.workers) ? rawStatus.workers : [];
  const listener = workers.find((worker) => worker.workerName === 'qianfan-listener') || {};
  const callback = workers.find((worker) => worker.workerName === 'wechat-callback') || {};
  const notifier = workers.find((worker) => worker.workerName === 'wechat-notifier') || {};

  const supervisorStatus = rawStatus.supervisorStatus || 'stopped';
  const relayRunning = ['starting', 'running', 'degraded'].includes(supervisorStatus);
  const qianfanReady = rawStatus.qianfanReady === true;
  const listenerReady = rawStatus.listenerReady === true;
  const wechatReady = rawStatus.wechatReady === true;

  const lastWorkerHeartbeatAt = workers.reduce((max, worker) => {
    const ts = Number(worker.lastHeartbeatAt || 0);
    return ts > max ? ts : max;
  }, 0) || null;

  const lastWatchdogFeedAt = Number(rawStatus.lastWatchdogFeedAt || 0) || null;

  const snapshot = {
    supervisorStatus,
    relayRunning,
    relayRunningFlag: relayRunning,
    qianfanReady,
    listenerReady,
    wechatReady,
    listener,
    callback,
    notifier,
    workers,
    notifyAccountCount: Number(options.notifyAccountCount || 0),
    lastWorkerHeartbeatAt,
    lastWatchdogFeedAt,
    lastStatusAt: now,
  };

  const worker = computeWatchdogHealth(lastWatchdogFeedAt, now);
  const qianfan = computeQianfanHealth(snapshot, now);
  const wechat = computeWechatHealth(snapshot, now);
  const relay = computeRelayHealth(snapshot, worker);
  const sections = { qianfan, wechat, relay, worker };
  const overall = computeOverallHealth(sections, snapshot, now);

  return {
    relayRunning,
    workerAlive: workers.some((item) => item.workerAlive !== false && item.status !== 'stopped'),
    qianfanReady,
    listenerReady,
    wechatReady,
    lastWorkerHeartbeatAt,
    lastWatchdogFeedAt,
    watchdogAgeMs: worker.watchdogAgeMs,
    watchdogStatus: worker.watchdogStatus,
    qianfanStatus: qianfan.qianfanStatus,
    wechatStatus: wechat.wechatStatus,
    relayStatus: relay.relayStatus,
    overallStatus: overall.overallStatus,
    overall,
    sections,
    progressLines: buildProgressLines(sections),
    lastStatusAt: now,
  };
}

const HEALTH_MODULE_LABELS = {
  qianfan: '千帆',
  wechat: '微信',
  relay: '中转',
  worker: 'worker/看门狗',
};

function describeHealthTransition(prevLevel, nextLevel) {
  if (!prevLevel || prevLevel === nextLevel) return null;
  const label = HEALTH_MODULE_LABELS;
  if (prevLevel === LEVEL.normal && nextLevel === LEVEL.warning) return '状态变为延迟/不稳定';
  if (prevLevel === LEVEL.warning && nextLevel === LEVEL.error) return '状态变为异常';
  if ((prevLevel === LEVEL.error || prevLevel === LEVEL.warning) && nextLevel === LEVEL.normal) return '状态已恢复正常';
  if (prevLevel === LEVEL.unknown && nextLevel === LEVEL.normal) return '状态已恢复正常';
  if (nextLevel === LEVEL.error) return '状态变为异常';
  if (nextLevel === LEVEL.warning) return '状态变为延迟/不稳定';
  if (nextLevel === LEVEL.normal) return '状态已恢复正常';
  return null;
}

function buildHealthTransitionLogs(prevHealth, nextHealth) {
  if (!prevHealth || !nextHealth) return [];
  const logs = [];
  for (const key of ['qianfan', 'wechat', 'relay', 'worker']) {
    const prevLevel = prevHealth.sections?.[key]?.level;
    const nextLevel = nextHealth.sections?.[key]?.level;
    const transition = describeHealthTransition(prevLevel, nextLevel);
    if (!transition) continue;
    logs.push({
      message: `${HEALTH_MODULE_LABELS[key]}${transition}`,
      dedupKey: `health-transition:${key}:${nextLevel}`,
      level: nextLevel === LEVEL.error ? 'error' : nextLevel === LEVEL.warning ? 'warn' : 'info',
    });
  }
  return logs;
}

function isRoutineHealthActivityMessage(message = '') {
  const text = String(message || '').trim();
  if (!text) return false;
  return /看门狗已喂食|看门狗已喂|watchdog feed|worker heartbeat|心跳正常|健康检查正常|看门狗已喂食：/i.test(text);
}

module.exports = {
  LEVEL,
  computeRuntimeHealth,
  computeWatchdogHealth,
  computeQianfanHealth,
  computeWechatHealth,
  computeRelayHealth,
  buildHealthTransitionLogs,
  isRoutineHealthActivityMessage,
  levelToProgressStatus,
};
