const state = {
  relayStatus: 'stopped',
  wechatStatus: 'unchecked',
  qianfanStatus: 'unchecked',
  notifierCount: 0,
  notifiers: [],
  todayForwardCount: 0,
  todayReplyCount: 0,
  activities: [],
  autoStart: false,
  starting: false,
  uploadingCookies: false,
  progressSteps: [],
  lastMessage: '',
  runtimeHealth: null,
  lastWatchdogFeedAt: null,
  lastWorkerHeartbeatAt: null,
  runtimeRunning: false,
};

const panel = {
  draftNotifiers: [],
  loadedFriends: null,
  loadingFriends: false,
  loadStatus: '',
};

const els = {
  heroCard: document.getElementById('hero-card'),
  mainStatusTitle: document.getElementById('main-status-title'),
  mainStatusDesc: document.getElementById('main-status-desc'),
  heroHint: document.getElementById('hero-hint'),
  heroHintText: document.getElementById('hero-hint-text'),
  btnSelectNotifierHero: document.getElementById('btn-select-notifier-hero'),
  progressPanel: document.getElementById('progress-panel'),
  progressSteps: document.getElementById('progress-steps'),
  btnStart: document.getElementById('btn-start'),
  btnStop: document.getElementById('btn-stop'),
  btnCheck: document.getElementById('btn-check'),
  btnUploadCookies: document.getElementById('btn-upload-cookies'),
  wechatText: document.getElementById('wechat-text'),
  qianfanText: document.getElementById('qianfan-text'),
  notifierBadge: document.getElementById('notifier-badge'),
  notifierText: document.getElementById('notifier-text'),
  btnNotifierCard: document.getElementById('btn-notifier-card'),
  todayForwardText: document.getElementById('today-forward-text'),
  todayReplyText: document.getElementById('today-reply-text'),
  cardWechat: document.getElementById('card-wechat'),
  cardQianfan: document.getElementById('card-qianfan'),
  cardNotifier: document.getElementById('card-notifier'),
  activityList: document.getElementById('activity-list'),
  activityEmpty: document.getElementById('activity-empty'),
  lastMessage: document.getElementById('last-message'),
  settingsOverlay: document.getElementById('settings-overlay'),
  btnSettings: document.getElementById('btn-settings'),
  btnCloseSettings: document.getElementById('btn-close-settings'),
  btnOpenNotifierFromSettings: document.getElementById('btn-open-notifier-from-settings'),
  autoStartToggle: document.getElementById('auto-start-toggle'),
  btnOpenConfig: document.getElementById('btn-open-config'),
  btnOpenLogs: document.getElementById('btn-open-logs'),
  btnAdvancedToggle: document.getElementById('btn-advanced-toggle'),
  advancedPanel: document.getElementById('advanced-panel'),
  advVersion: document.getElementById('adv-version'),
  advConfigDir: document.getElementById('adv-config-dir'),
  advLogsDir: document.getElementById('adv-logs-dir'),
  notifierOverlay: document.getElementById('notifier-overlay'),
  btnCloseNotifier: document.getElementById('btn-close-notifier'),
  friendsLoading: document.getElementById('friends-loading'),
  friendsStatus: document.getElementById('friends-status'),
  friendsList: document.getElementById('friends-list'),
  friendsEmpty: document.getElementById('friends-empty'),
  draftNotifierList: document.getElementById('draft-notifier-list'),
  draftNotifierEmpty: document.getElementById('draft-notifier-empty'),
  btnManualToggle: document.getElementById('btn-manual-toggle'),
  manualPanel: document.getElementById('manual-panel'),
  manualWxid: document.getElementById('manual-wxid'),
  manualNickname: document.getElementById('manual-nickname'),
  btnManualAdd: document.getElementById('btn-manual-add'),
  draftCountText: document.getElementById('draft-count-text'),
  btnSaveNotifiers: document.getElementById('btn-save-notifiers'),
  btnCancelNotifiers: document.getElementById('btn-cancel-notifiers'),
  toast: document.getElementById('toast'),
};

let toastTimer = null;
let statusPollTimer = null;
let progressDisplayTimer = null;
let progressRefreshTick = 0;
let unsubscribeRuntimeStatus = null;
let unsubscribeRuntimeLog = null;
let unsubscribeRuntimeStats = null;
let unsubscribeRelayLog = null;
const activityDedupSeen = new Map();
const ACTIVITY_DEDUP_MS = 3000;
const ACTIVITY_MAX_ITEMS = 100;
const WATCHDOG_NORMAL_MS = 15000;
const WATCHDOG_WARN_MS = 25000;

function formatAgeSec(ageMs) {
  if (ageMs == null || !Number.isFinite(ageMs)) return '';
  return `${Math.max(0, Math.floor(ageMs / 1000))} 秒前`;
}

function buildWorkerProgressLine(lastWatchdogFeedAt, lastWorkerHeartbeatAt) {
  const feed = Number(lastWatchdogFeedAt || 0);
  const worker = Number(lastWorkerHeartbeatAt || 0);
  const effectiveFeedAt = feed && worker ? Math.max(feed, worker) : (feed || worker || 0);
  if (!effectiveFeedAt) {
    return { text: '● worker 等待心跳', status: 'unknown' };
  }
  const ageMs = Date.now() - effectiveFeedAt;
  if (ageMs <= WATCHDOG_NORMAL_MS) {
    return {
      text: `● worker 正常 · 看门狗 ${formatAgeSec(ageMs)} ✓`,
      status: 'done',
      showCheck: true,
    };
  }
  if (ageMs <= WATCHDOG_WARN_MS) {
    return {
      text: `● worker 心跳延迟 · 上次看门狗 ${formatAgeSec(ageMs)}`,
      status: 'warn',
    };
  }
  return {
    text: `● worker 心跳超时 · 上次看门狗 ${formatAgeSec(ageMs)} !`,
    status: 'error',
  };
}

function mergeProgressWithWorkerAge(progressLines, lastWatchdogFeedAt, lastWorkerHeartbeatAt) {
  const lines = Array.isArray(progressLines) ? progressLines : [];
  const workerLine = buildWorkerProgressLine(lastWatchdogFeedAt, lastWorkerHeartbeatAt);
  return lines.map((line) => (
    line.key === 'worker'
      ? { ...line, text: workerLine.text, status: workerLine.status, showCheck: workerLine.showCheck === true }
      : line
  ));
}

function applyRuntimeHealth(health, runtimeStatus = {}) {
  state.runtimeHealth = health || null;
  state.lastWatchdogFeedAt = runtimeStatus.lastWatchdogFeedAt || health?.lastWatchdogFeedAt || null;
  state.lastWorkerHeartbeatAt = runtimeStatus.lastWorkerHeartbeatAt || health?.lastWorkerHeartbeatAt || null;
  state.runtimeRunning = health?.relayRunning === true;
  if (health?.progressLines?.length) {
    state.progressSteps = mergeProgressWithWorkerAge(
      health.progressLines,
      state.lastWatchdogFeedAt,
      state.lastWorkerHeartbeatAt,
    );
  }
}

function isRoutineHealthActivity(text = '') {
  return /看门狗已喂食|看门狗已喂|watchdog feed|worker heartbeat|心跳正常|健康检查正常/i.test(String(text));
}

function startProgressDisplayTimer() {
  stopProgressDisplayTimer();
  progressRefreshTick = 0;
  progressDisplayTimer = setInterval(async () => {
    if (!state.runtimeRunning || !state.runtimeHealth?.progressLines?.length) return;
    progressRefreshTick += 1;
    if (progressRefreshTick % 3 === 0) {
      await refreshBackendStatus();
    } else {
      state.progressSteps = mergeProgressWithWorkerAge(
        state.runtimeHealth.progressLines,
        state.lastWatchdogFeedAt,
        state.lastWorkerHeartbeatAt,
      );
    }
    renderProgress();
  }, 1000);
}

function stopProgressDisplayTimer() {
  if (!progressDisplayTimer) return;
  clearInterval(progressDisplayTimer);
  progressDisplayTimer = null;
}

function formatActivityTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

function buildActivityDedupKey(entry = {}) {
  const workerName = entry.workerName || '';
  const level = entry.level || 'info';
  const message = String(entry.message || entry.text || '').trim();
  return `${workerName}:${level}:${message}`;
}

function shouldShowActivity(key) {
  const normalized = String(key || '').trim();
  if (!normalized) return true;
  const now = Date.now();
  const last = activityDedupSeen.get(normalized);
  if (last === undefined) {
    activityDedupSeen.set(normalized, now);
    return true;
  }
  if (now - last < ACTIVITY_DEDUP_MS) return false;
  activityDedupSeen.set(normalized, now);
  return true;
}

function nowTime() {
  return formatActivityTime(Date.now());
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2800);
}

function addActivity(text, meta = {}) {
  const dedupKey = meta.dedupKey || text;
  if (!shouldShowActivity(dedupKey)) return;
  state.activities.unshift({ time: nowTime(), text });
  if (state.activities.length > ACTIVITY_MAX_ITEMS) {
    state.activities = state.activities.slice(0, ACTIVITY_MAX_ITEMS);
  }
  renderActivities();
}

function addRuntimeActivity(entry) {
  if (!entry) return;
  const text = String(entry.message || '').slice(0, 200);
  if (!text || isRoutineHealthActivity(text)) return;
  const dedupKey = entry.dedupKey || buildActivityDedupKey(entry);
  if (!shouldShowActivity(dedupKey)) return;
  state.activities.unshift({
    time: entry.displayTime || formatActivityTime(entry.time || Date.now()),
    text: text.slice(0, 120),
  });
  if (state.activities.length > ACTIVITY_MAX_ITEMS) {
    state.activities = state.activities.slice(0, ACTIVITY_MAX_ITEMS);
  }
  renderActivities();
  if (/已通知微信|已成功回复千帆|回复千帆失败/.test(text)) {
    void refreshTodayStats().then(() => renderCards());
  }
}

function cloneNotifier(item) {
  return {
    wxid: item.wxid,
    nickname: item.nickname || item.wxid,
    wechatNo: item.wechatNo || item.remark || '',
    remark: item.remark || item.wechatNo || '',
    avatar: item.avatar || '',
  };
}

async function saveNotifiers() {
  const saved = await window.qianfanApp.setNotifyAccounts(state.notifiers);
  state.notifiers = saved.map(cloneNotifier);
  state.notifierCount = state.notifiers.length;
}

async function loadNotifiers() {
  try {
    const list = await window.qianfanApp.getNotifyAccounts();
    state.notifiers = Array.isArray(list) ? list.map(cloneNotifier) : [];
  } catch {
    state.notifiers = [];
  }
  state.notifierCount = state.notifiers.length;
}

async function saveAutoStart() {
  if (window.qianfanApp?.setAutoStart) {
    await window.qianfanApp.setAutoStart(state.autoStart);
    return;
  }
}

async function loadAutoStart() {
  if (window.qianfanApp?.getUiPreferences) {
    try {
      const prefs = await window.qianfanApp.getUiPreferences();
      state.autoStart = prefs?.autoStart === true;
      return;
    } catch {
      // ignore
    }
  }
  state.autoStart = false;
}

function getTrayStatusKey() {
  if (state.starting) return 'attention';
  if (state.relayStatus === 'running') return 'running';
  if (state.relayStatus === 'attention' || state.relayStatus === 'needs_action') return 'attention';
  return 'stopped';
}

function getTrayStatusText() {
  const map = { stopped: '未启动', running: '运行中', attention: '需要处理' };
  return map[getTrayStatusKey()] || '未启动';
}

function syncTray() {
  if (!window.qianfanApp?.syncTrayState) return;
  const relayActive = state.relayStatus === 'running' || state.relayStatus === 'attention';
  window.qianfanApp.syncTrayState({
    statusKey: getTrayStatusKey(),
    statusText: getTrayStatusText(),
    relayRunning: relayActive,
    starting: state.starting,
  });
}

function applyTodayStats(stats) {
  if (!stats || typeof stats !== 'object') return;
  state.todayForwardCount = Math.max(0, Number(stats.forwardCount) || 0);
  state.todayReplyCount = Math.max(0, Number(stats.replyCount) || 0);
}

async function refreshTodayStats() {
  if (!window.qianfanApp?.getTodayStats) return;
  try {
    const stats = await window.qianfanApp.getTodayStats();
    applyTodayStats(stats);
  } catch {
    // ignore
  }
}

async function refreshBackendStatus() {
  if (!window.qianfanApp?.getStatus) return null;
  try {
    const backendStatus = await window.qianfanApp.getStatus();
    const bot = backendStatus?.bot || {};
    const qianfanMod = backendStatus?.modules?.['qianfan-listener'] || {};
    const wechatMod = backendStatus?.modules?.['wechat-runtime'] || {};

    const qianfanPhase = qianfanMod.phase || bot.qianfanPhase || '';
    if (bot.qianfanReady && qianfanMod.listenerReady) state.qianfanStatus = 'ok';
    else if (qianfanPhase === 'launching' || qianfanPhase === 'checking') state.qianfanStatus = 'launching';
    else if (
      qianfanPhase === 'waiting_shops'
      || qianfanPhase === 'waiting_launch'
      || qianfanMod.qianfanReady
      || qianfanPhase === 'qianfan_ready'
      || qianfanPhase === 'attached'
    ) {
      state.qianfanStatus = qianfanPhase === 'waiting_shops'
        ? 'waiting_shops'
        : qianfanPhase === 'waiting_launch'
          ? 'launching'
          : 'connecting';
    } else if (qianfanMod.status === 'failed' || bot.qianfanError) state.qianfanStatus = 'error';
    else if (bot.running || bot.starting) state.qianfanStatus = 'launching';
    else state.qianfanStatus = 'not_open';

    if (bot.wechatReady || wechatMod.businessReady) state.wechatStatus = 'ok';
    else if (bot.bootWaiting || wechatMod.status === 'waiting_manual') state.wechatStatus = 'need_login';
    else if (bot.running) state.wechatStatus = 'need_login';

    if (bot.fullReady) {
      state.relayStatus = 'running';
      state.starting = false;
    } else if (bot.running || bot.degraded) {
      state.relayStatus = 'attention';
      if (!bot.starting) state.starting = false;
      if (bot.qianfanError && shouldShowActivity(`qianfan-error:${bot.qianfanError}`)) {
        const err = String(bot.qianfanError || '').trim();
        const readable = /[a-z]{5,}/i.test(err) && !/千帆|调试|端口|工作台/.test(err)
          ? '千帆连接异常，请查看千帆客服台状态'
          : err;
        addActivity(readable, { dedupKey: `qianfan-error:${readable}` });
      }
    } else if (!state.starting) {
      state.relayStatus = 'stopped';
    }

    applyTodayStats(backendStatus.todayStats || backendStatus.runtime?.todayStats);
    applyRuntimeHealth(backendStatus.health || backendStatus.runtime?.health, backendStatus.runtime);
    await refreshTodayStats();
    return backendStatus;
  } catch {
    return null;
  }
}

function scheduleBackendStatusRefresh() {
  [2000, 5000, 10000, 20000].forEach((delay) => {
    setTimeout(async () => {
      await refreshBackendStatus();
      renderAll();
    }, delay);
  });
}

function wechatLabel() {
  const map = {
    unchecked: '还没检查',
    ok: '微信已准备好',
    need_login: '微信还没登录，请扫码',
    error: '微信助手没启动',
  };
  return map[state.wechatStatus] || '还没检查';
}

function qianfanLabel() {
  const map = {
    unchecked: '还没检查',
    ok: '千帆客服台已连接',
    launching: '正在通过 cmd 以调试模式启动千帆…',
    waiting_shops: '千帆已启动，等待店铺页面加载…',
    connecting: '千帆已接入，正在启动监听…',
    not_open: '没有找到千帆客服台，请先打开',
    error: '千帆客服台连接异常',
  };
  return map[state.qianfanStatus] || '还没检查';
}

function cardTone(type) {
  if (type === 'wechat') {
    if (state.wechatStatus === 'ok') return 'ok';
    if (state.wechatStatus === 'need_login') return 'warn';
    if (state.wechatStatus === 'error') return 'error';
    return 'neutral';
  }
  if (type === 'qianfan') {
    if (state.qianfanStatus === 'ok') return 'ok';
    if (state.qianfanStatus === 'connecting' || state.qianfanStatus === 'launching' || state.qianfanStatus === 'waiting_shops') return 'warn';
    if (state.qianfanStatus === 'not_open') return 'warn';
    if (state.qianfanStatus === 'error') return 'error';
    return 'neutral';
  }
  if (type === 'notifier') return state.notifierCount > 0 ? 'ok' : 'warn';
  return 'neutral';
}

function renderMainStatus() {
  if (state.starting) {
    els.mainStatusTitle.textContent = '正在启动';
    els.mainStatusDesc.textContent = '请稍等，正在帮你连接微信和千帆';
    els.heroCard.dataset.state = 'attention';
    els.heroHint.classList.add('hidden');
    return;
  }

  if (state.relayStatus === 'needs_action') {
    els.mainStatusTitle.textContent = '需要先设置通知人';
    els.mainStatusDesc.textContent = '还没有设置通知人，请先选择一个微信好友接收通知。';
    els.heroCard.dataset.state = 'attention';
    els.heroHint.classList.remove('hidden');
    els.heroHintText.textContent = '还没有设置通知人，请先选择一个微信好友接收通知。';
    return;
  }

  const health = state.runtimeHealth;
  if (health?.overall && (state.relayStatus === 'running' || state.relayStatus === 'attention' || state.runtimeRunning)) {
    els.mainStatusTitle.textContent = health.overall.title;
    els.mainStatusDesc.textContent = health.overall.subtitle;
    els.heroCard.dataset.state = health.overall.heroState;
    if (health.overall.level === 'error' && health.sections?.qianfan?.level === 'error') {
      els.heroHint.classList.remove('hidden');
      els.heroHintText.textContent = '千帆连接失败，请检查千帆安装路径，或手动运行「启动千帆调试模式.bat」';
    } else {
      els.heroHint.classList.add('hidden');
    }
    return;
  }

  if (state.relayStatus === 'running') {
    els.mainStatusTitle.textContent = '中转运行中';
    els.mainStatusDesc.textContent = '正在帮你转发消息';
    els.heroCard.dataset.state = 'running';
    els.heroHint.classList.add('hidden');
    return;
  }

  if (state.relayStatus === 'attention' && state.qianfanStatus !== 'ok') {
    if (state.qianfanStatus === 'launching' || state.qianfanStatus === 'waiting_shops' || state.qianfanStatus === 'connecting') {
      els.mainStatusTitle.textContent = '正在启动';
      els.mainStatusDesc.textContent = qianfanLabel();
      els.heroCard.dataset.state = 'attention';
      els.heroHint.classList.remove('hidden');
      els.heroHintText.textContent = state.qianfanStatus === 'waiting_shops'
        ? '千帆正在加载店铺页面，通常需要 10～30 秒，请稍候'
        : '正在自动启动并连接千帆客服工作台，请稍候';
      return;
    }
    els.mainStatusTitle.textContent = '需要处理';
    els.mainStatusDesc.textContent = state.qianfanStatus === 'error'
      ? '千帆客服台连接异常，请查看下方提示'
      : '千帆客服台未接入，正在尝试自动启动';
    els.heroCard.dataset.state = 'attention';
    els.heroHint.classList.remove('hidden');
    els.heroHintText.textContent = state.qianfanStatus === 'error'
      ? '千帆连接失败，请检查千帆安装路径，或手动运行「启动千帆调试模式.bat」'
      : '软件会自动通过 cmd 以调试模式启动千帆，请稍候';
    return;
  }

  if (state.relayStatus === 'needs_action') {
    els.mainStatusTitle.textContent = '需要先设置通知人';
    els.mainStatusDesc.textContent = '还没有设置通知人，请先选择一个微信好友接收通知。';
    els.heroCard.dataset.state = 'attention';
    els.heroHint.classList.remove('hidden');
    els.heroHintText.textContent = '还没有设置通知人，请先选择一个微信好友接收通知。';
    return;
  }

  if (state.relayStatus === 'attention') {
    els.mainStatusTitle.textContent = '需要处理';
    els.mainStatusDesc.textContent = '有地方没准备好，请看下面提示';
    els.heroCard.dataset.state = 'attention';
    els.heroHint.classList.add('hidden');
    return;
  }

  els.mainStatusTitle.textContent = '中转未启动';
  els.mainStatusDesc.textContent = '点击下方按钮开始中转';
  els.heroCard.dataset.state = 'stopped';
  if (state.notifierCount === 0) {
    els.heroHint.classList.remove('hidden');
    els.heroHintText.textContent = '还没有设置通知人，请先选择一个微信好友接收通知。';
  } else {
    els.heroHint.classList.add('hidden');
  }
}

function setProgressSteps(steps) {
  state.progressSteps = steps;
  renderProgress();
}

function renderProgress() {
  const show = state.starting || (state.runtimeRunning && state.progressSteps.length > 0);
  els.progressPanel.classList.toggle('hidden', !show);
  if (!show) {
    els.progressSteps.innerHTML = '';
    return;
  }
  els.progressSteps.innerHTML = state.progressSteps.map((step) => {
    const cls = [
      step.status === 'done' ? 'done' : '',
      step.status === 'active' ? 'active' : '',
      step.status === 'warn' ? 'warn' : '',
      step.status === 'unknown' ? 'unknown' : '',
      step.status === 'error' ? 'error' : '',
    ].filter(Boolean).join(' ');
    const check = step.showCheck ? '<span class="progress-check" aria-hidden="true">✓</span>' : '';
    const mark = step.status === 'error' ? '<span class="progress-check" aria-hidden="true">!</span>' : check;
    return `<li class="${cls}"><span class="progress-dot"></span><div class="progress-content"><span class="progress-text">${escapeHtml(step.text)}${mark}</span></div></li>`;
  }).join('');
}

function renderButtons() {
  const running = state.relayStatus === 'running' || state.relayStatus === 'attention';
  els.btnStart.disabled = running || state.starting;
  els.btnStop.disabled = !running || state.starting;
  els.btnCheck.disabled = state.starting;
  if (els.btnUploadCookies) {
    els.btnUploadCookies.disabled = state.starting || Boolean(state.uploadingCookies);
    els.btnUploadCookies.textContent = state.uploadingCookies ? '提交中…' : '提交 Cookie';
  }
}

function renderCards() {
  els.wechatText.textContent = wechatLabel();
  els.qianfanText.textContent = qianfanLabel();
  if (state.notifierCount > 0) {
    els.notifierBadge.textContent = '已设置';
    els.notifierText.textContent = `已设置 ${state.notifierCount} 个微信通知人`;
    els.btnNotifierCard.textContent = '查看 / 修改';
  } else {
    els.notifierBadge.textContent = '未设置';
    els.notifierText.textContent = '还没有选择接收通知的微信好友';
    els.btnNotifierCard.textContent = '选择通知人';
  }
  els.todayForwardText.textContent = `今日已转发 ${state.todayForwardCount} 条`;
  els.todayReplyText.textContent = `今日已回复 ${state.todayReplyCount} 条`;
  els.cardWechat.dataset.tone = cardTone('wechat');
  els.cardQianfan.dataset.tone = cardTone('qianfan');
  els.cardNotifier.dataset.tone = cardTone('notifier');
}

function renderActivities() {
  const hasItems = state.activities.length > 0;
  els.activityList.innerHTML = state.activities.map((item) => (
    `<li><span class="activity-time">${item.time}</span><span>${escapeHtml(item.text)}</span></li>`
  )).join('');
  els.activityList.classList.toggle('hidden', !hasItems);
  els.activityEmpty.classList.toggle('hidden', hasItems);
  if (state.lastMessage) {
    els.lastMessage.textContent = `最近一条：${state.lastMessage}`;
    els.lastMessage.classList.remove('hidden');
  } else {
    els.lastMessage.classList.add('hidden');
  }
}

function renderAll() {
  renderMainStatus();
  renderProgress();
  renderButtons();
  renderCards();
  renderActivities();
  els.autoStartToggle.checked = state.autoStart;
  syncTray();
}

function openSettings() {
  void loadAutoStart().then(() => {
    els.autoStartToggle.checked = state.autoStart;
  });
  els.settingsOverlay.classList.remove('hidden');
  els.settingsOverlay.setAttribute('aria-hidden', 'false');
}

function closeSettings() {
  els.settingsOverlay.classList.add('hidden');
  els.settingsOverlay.setAttribute('aria-hidden', 'true');
}

function openNotifierPanel() {
  panel.draftNotifiers = state.notifiers.map(cloneNotifier);
  panel.loadedFriends = null;
  panel.loadingFriends = false;
  panel.loadStatus = '';
  els.notifierOverlay.classList.remove('hidden');
  els.notifierOverlay.setAttribute('aria-hidden', 'false');
  renderNotifierPanel();
  void loadWechatFriends();
}

function closeNotifierPanel() {
  els.notifierOverlay.classList.add('hidden');
  els.notifierOverlay.setAttribute('aria-hidden', 'true');
}

function isDraftSelected(wxid) {
  return panel.draftNotifiers.some((item) => item.wxid === wxid);
}

function avatarHtml(item, indexKey = '') {
  const avatarUrl = String(item.avatar || '').trim();
  const label = (item.nickname || item.wxid || '?').slice(0, 1);
  if (avatarUrl) {
    return `<img class="avatar avatar-img" data-fallback="${escapeHtml(label)}" data-avatar-key="${escapeHtml(indexKey || item.wxid || '')}" src="${escapeHtml(avatarUrl)}" alt="" referrerpolicy="no-referrer" loading="lazy">`;
  }
  return `<span class="avatar">${escapeHtml(label)}</span>`;
}

function bindAvatarFallbacks(root = document) {
  root.querySelectorAll('img.avatar-img').forEach((img) => {
    if (img.dataset.bound === '1') return;
    img.dataset.bound = '1';
    img.addEventListener('error', () => {
      void retryAvatarLoad(img);
    }, { once: true });
  });
}

async function retryAvatarLoad(img) {
  const src = String(img.getAttribute('src') || '').trim();
  if (!img.dataset.proxyTried && src && window.qianfanApp?.fetchAvatarDataUrl) {
    img.dataset.proxyTried = '1';
    try {
      const dataUrl = await window.qianfanApp.fetchAvatarDataUrl(src);
      if (dataUrl) {
        img.addEventListener('error', () => replaceAvatarWithFallback(img), { once: true });
        img.src = dataUrl;
        return;
      }
    } catch {
      // ignore
    }
  }
  replaceAvatarWithFallback(img);
}

function replaceAvatarWithFallback(img) {
  const fallback = document.createElement('span');
  fallback.className = 'avatar';
  fallback.textContent = img.dataset.fallback || '?';
  img.replaceWith(fallback);
}

function friendMeta(item) {
  const nickname = escapeHtml(item.nickname || item.wxid);
  const wechatId = escapeHtml(item.wechatNo || item.wxid);
  return `<div class="friend-meta"><strong>${nickname}</strong><span class="friend-wechat-id">微信ID：${wechatId}</span></div>`;
}

function renderFriendsList() {
  const friends = panel.loadedFriends || [];
  const hasFriends = friends.length > 0;
  els.friendsList.innerHTML = friends.map((friend) => {
    const selected = isDraftSelected(friend.wxid);
    const actionLabel = selected ? '已添加 ✓' : '添加';
    const actionClass = selected ? 'btn btn-sm btn-added' : 'btn btn-sm btn-primary';
    const disabledAttr = selected ? ' disabled aria-disabled="true"' : '';
    return `<li class="friend-item">${avatarHtml(friend)}${friendMeta(friend)}<button type="button" class="${actionClass}" data-add-friend="${escapeHtml(friend.wxid)}"${disabledAttr}>${actionLabel}</button></li>`;
  }).join('');
  els.friendsEmpty.classList.toggle('hidden', hasFriends || panel.loadingFriends || panel.loadStatus);
  els.friendsList.classList.toggle('hidden', !hasFriends);
  els.friendsLoading.classList.toggle('hidden', !panel.loadingFriends);
  if (panel.loadStatus) {
    els.friendsStatus.textContent = panel.loadStatus;
    els.friendsStatus.classList.remove('hidden');
  } else {
    els.friendsStatus.textContent = '';
    els.friendsStatus.classList.add('hidden');
  }
}

function renderDraftNotifiers() {
  const hasItems = panel.draftNotifiers.length > 0;
  els.draftNotifierList.innerHTML = panel.draftNotifiers.map((item) => `
    <li class="notifier-manage-item">
      ${avatarHtml(item)}
      <div class="friend-meta"><strong>${escapeHtml(item.nickname || item.wxid)}</strong><span class="friend-wechat-id">微信ID：${escapeHtml(item.wechatNo || item.wxid)}</span></div>
      <div class="manage-actions">
        <button type="button" class="btn btn-sm btn-primary" data-send-test="${escapeHtml(item.wxid)}">发送测试通知</button>
        <button type="button" class="btn btn-sm btn-danger" data-remove-draft="${escapeHtml(item.wxid)}">删除</button>
      </div>
    </li>
  `).join('');
  els.draftNotifierEmpty.classList.toggle('hidden', hasItems);
  els.draftCountText.textContent = `已添加 ${panel.draftNotifiers.length} 个通知人`;
}

function renderNotifierPanel() {
  renderFriendsList();
  renderDraftNotifiers();
  bindAvatarFallbacks(els.notifierOverlay);
}

async function loadWechatFriends() {
  panel.loadingFriends = true;
  panel.loadedFriends = null;
  panel.loadStatus = '正在连接微信助手…';
  renderFriendsList();

  const prepare = await window.qianfanApp.ensureWechatReady();
  if (!prepare.ok && !prepare.waiting) {
    panel.loadingFriends = false;
    panel.loadStatus = `${prepare.message}\n如果刚打开微信，请先点击「启动中转」后再试。`;
    renderFriendsList();
    showToast(prepare.message);
    return;
  }

  panel.loadStatus = '正在读取微信好友…';
  renderFriendsList();
  const result = await window.qianfanApp.listWechatFriends();
  panel.loadingFriends = false;

  if (!result.ok) {
    panel.loadedFriends = [];
    panel.loadStatus = `${result.message}\n请确认 wxbot 已注入且微信已登录。`;
    renderFriendsList();
    return;
  }

  panel.loadedFriends = result.friends || [];
  panel.loadStatus = panel.loadedFriends.length ? '' : '没有读取到好友';
  renderFriendsList();
}

async function handleCheckEnvironment() {
  els.btnCheck.disabled = true;
  addActivity('正在检查环境…');
  try {
    const result = await window.qianfanApp.checkEnvironment();
    const wechat = result.wechat || {};
    state.wechatStatus = wechat.ok ? 'ok' : wechat.stage === 'login' ? 'need_login' : 'error';
    const qianfanMod = result.qianfanListener || {};
    state.qianfanStatus = qianfanMod.status === 'running' ? 'ok' : 'not_open';
    const issueCount = result.issueCount ?? (result.issues?.length || 0);
    if (issueCount > 0) state.relayStatus = state.relayStatus === 'running' ? state.relayStatus : 'attention';
    const issueText = issueCount === 0 ? '环境检查完成，一切正常' : `环境检查完成，有 ${issueCount} 项需要处理`;
    addActivity(issueText);
    state.lastMessage = issueText;
    renderAll();
    showToast(issueText);
  } catch (error) {
    showToast(`环境检查失败：${error.message}`);
  } finally {
    els.btnCheck.disabled = false;
  }
}

function formatShopCookieFeedback(result) {
  const shops = Array.isArray(result?.shops) ? result.shops : [];
  if (!shops.length) return result?.message || 'Cookie 提交失败';
  const okLines = shops.filter((s) => s.ok).map((s) => {
    const preview = s.cookiePreview ? ` ${s.cookiePreview}` : '';
    return `${s.shopName} ✓${preview}`;
  });
  const failLines = shops.filter((s) => !s.ok).map((s) => `${s.shopName} ✗ ${s.message || '失败'}`);
  const summary = result.ok
    ? `Cookie 提交成功（${result.success || okLines.length}/4）`
    : `Cookie 提交${(result.success || 0) > 0 ? '部分成功' : '失败'}（${result.success || 0}/4）`;
  return [summary, ...okLines, ...failLines].join('\n');
}

async function handleUploadShopCookies() {
  if (!els.btnUploadCookies || state.uploadingCookies) return;
  state.uploadingCookies = true;
  renderButtons();
  addActivity('正在采集并提交四店 Cookie…');
  showToast('正在提交四店 Cookie…');
  try {
    const result = await window.qianfanApp.uploadShopCookies();
    const feedback = formatShopCookieFeedback(result);
    addActivity(feedback);
    state.lastMessage = feedback.split('\n')[0];
    renderAll();
    showToast(feedback.split('\n')[0]);
    if (result.ok && window.qianfanApp.showTrayNotification) {
      void window.qianfanApp.showTrayNotification({
        title: 'Cookie 提交成功',
        body: feedback.split('\n')[0],
      });
    }
  } catch (error) {
    const msg = `Cookie 提交失败：${error.message}`;
    addActivity(msg);
    showToast(msg);
  } finally {
    state.uploadingCookies = false;
    renderButtons();
  }
}

async function handleStartRelay() {
  if (state.notifierCount === 0) {
    state.relayStatus = 'needs_action';
    addActivity('启动失败：还没有设置通知人');
    renderAll();
    showToast('还没有设置通知人，请先选择一个微信好友接收通知。');
    return;
  }
  if (state.relayStatus === 'running' || state.starting) return;

  state.starting = true;
  renderAll();
  setProgressSteps([
    { text: '正在通过 cmd 以调试模式启动千帆…', status: 'active' },
    { text: '等待千帆店铺就绪…', status: 'pending' },
    { text: '等待启动微信…', status: 'pending' },
  ]);

  const startResult = await window.qianfanApp.startRelay();
  if (!startResult.ok) {
    state.starting = false;
    setProgressSteps([{ text: startResult.message || '启动失败', status: 'error' }]);
    addActivity(startResult.message || '启动失败');
    renderAll();
    showToast(startResult.message || '启动失败');
    return;
  }

  addActivity('正在自动启动千帆，就绪后再启动微信…');
  state.lastMessage = '正在自动启动千帆，就绪后再启动微信';
  setProgressSteps([
    { text: '正在启动千帆客服工作台…', status: 'active' },
    { text: '等待千帆店铺就绪…', status: 'pending' },
    { text: '等待启动微信…', status: 'pending' },
  ]);
  scheduleBackendStatusRefresh();
  startStatusPolling();
}

async function handleStopRelay() {
  state.starting = false;
  const result = await window.qianfanApp.stopRelay();
  stopStatusPolling();
  stopProgressDisplayTimer();
  state.relayStatus = 'stopped';
  state.wechatStatus = 'unchecked';
  state.qianfanStatus = 'unchecked';
  state.runtimeHealth = null;
  state.runtimeRunning = false;
  state.lastWatchdogFeedAt = null;
  state.lastWorkerHeartbeatAt = null;
  state.progressSteps = [];
  addActivity(result.ok ? '中转已停止' : '停止中转失败');
  renderAll();
  showToast(result.ok ? '中转已停止' : '停止中转失败');
}

function startStatusPolling() {
  stopStatusPolling();
  statusPollTimer = setInterval(async () => {
    const backendStatus = await refreshBackendStatus();
    const bot = backendStatus?.bot || {};
    if (bot.fullReady) {
      stopStatusPolling();
      startProgressDisplayTimer();
    }
    renderAll();
  }, 3000);
}

function stopStatusPolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

function bindEvents() {
  els.btnStart.addEventListener('click', () => void handleStartRelay());
  els.btnStop.addEventListener('click', () => void handleStopRelay());
  els.btnCheck.addEventListener('click', () => void handleCheckEnvironment());
  if (els.btnUploadCookies) {
    els.btnUploadCookies.addEventListener('click', () => void handleUploadShopCookies());
  }
  els.btnSettings.addEventListener('click', openSettings);
  els.btnCloseSettings.addEventListener('click', closeSettings);
  els.btnOpenNotifierFromSettings.addEventListener('click', () => { closeSettings(); openNotifierPanel(); });
  els.btnNotifierCard.addEventListener('click', openNotifierPanel);
  els.btnSelectNotifierHero.addEventListener('click', openNotifierPanel);
  els.btnCloseNotifier.addEventListener('click', closeNotifierPanel);
  els.btnCancelNotifiers.addEventListener('click', closeNotifierPanel);
  els.btnOpenConfig.addEventListener('click', () => void window.qianfanApp.openConfigDir());
  els.btnOpenLogs.addEventListener('click', () => void window.qianfanApp.openLogsDir());
  els.autoStartToggle.addEventListener('change', () => {
    state.autoStart = els.autoStartToggle.checked;
    void saveAutoStart();
  });
  els.btnAdvancedToggle.addEventListener('click', () => {
    const expanded = els.btnAdvancedToggle.getAttribute('aria-expanded') === 'true';
    els.btnAdvancedToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    els.advancedPanel.classList.toggle('hidden', expanded);
  });
  els.btnManualToggle.addEventListener('click', () => {
    const expanded = els.btnManualToggle.getAttribute('aria-expanded') === 'true';
    els.btnManualToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    els.manualPanel.classList.toggle('hidden', expanded);
  });
  els.btnManualAdd.addEventListener('click', () => {
    const wxid = els.manualWxid.value.trim();
    const nickname = els.manualNickname.value.trim();
    if (!wxid) return showToast('请输入 wxid');
    if (isDraftSelected(wxid)) return showToast('这个通知人已经添加过了');
    panel.draftNotifiers.push(cloneNotifier({ wxid, nickname: nickname || wxid, remark: '' }));
    els.manualWxid.value = '';
    els.manualNickname.value = '';
    renderNotifierPanel();
  });
  els.btnSaveNotifiers.addEventListener('click', async () => {
    if (!panel.draftNotifiers.length) return showToast('请至少添加一个通知人');
    state.notifiers = panel.draftNotifiers.map(cloneNotifier);
    state.notifierCount = state.notifiers.length;
    if (state.relayStatus === 'needs_action') state.relayStatus = 'stopped';
    try {
      await saveNotifiers();
    } catch (error) {
      return showToast(`保存失败：${error.message}`);
    }
    closeNotifierPanel();
    renderAll();
    showToast(`已设置 ${state.notifierCount} 个微信通知人`);
  });

  els.friendsList.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-add-friend]');
    if (!btn || btn.disabled) return;
    const wxid = btn.getAttribute('data-add-friend');
    const friend = (panel.loadedFriends || []).find((item) => item.wxid === wxid);
    if (!friend || isDraftSelected(wxid)) return;
    panel.draftNotifiers.push(cloneNotifier(friend));
    renderNotifierPanel();
  });

  els.draftNotifierList.addEventListener('click', async (event) => {
    const removeBtn = event.target.closest('[data-remove-draft]');
    if (removeBtn) {
      panel.draftNotifiers = panel.draftNotifiers.filter((item) => item.wxid !== removeBtn.getAttribute('data-remove-draft'));
      renderNotifierPanel();
      return;
    }
    const testBtn = event.target.closest('[data-send-test]');
    if (testBtn) {
      const wxid = testBtn.getAttribute('data-send-test');
      const result = await window.qianfanApp.sendTestWechatMessage(wxid);
      showToast(result.ok ? '测试通知已发送' : `发送失败：${result.message}`);
    }
  });

  window.qianfanApp.onTrayAction((action) => {
    if (action === 'start') void handleStartRelay();
    if (action === 'stop') void handleStopRelay();
    if (action === 'check') void handleCheckEnvironment();
  });

  if (unsubscribeRelayLog) unsubscribeRelayLog();
  unsubscribeRelayLog = null;

  window.qianfanApp.onRelayProcessExit(() => {
    stopStatusPolling();
    state.starting = false;
    if (state.relayStatus !== 'stopped') state.relayStatus = 'attention';
    addActivity('中转已停止');
    renderAll();
  });

  setupRuntimeListeners();
}

function setupRuntimeListeners() {
  if (!window.qianfanApp) return;
  if (unsubscribeRuntimeStatus) unsubscribeRuntimeStatus();
  if (unsubscribeRuntimeLog) unsubscribeRuntimeLog();
  if (unsubscribeRuntimeStats) unsubscribeRuntimeStats();

  if (window.qianfanApp.onRuntimeStatus) {
    unsubscribeRuntimeStatus = window.qianfanApp.onRuntimeStatus((runtimeStatus) => {
      const running = ['starting', 'running', 'degraded'].includes(runtimeStatus.supervisorStatus);
      const qianfanReady = runtimeStatus.qianfanReady === true;
      const wechatReady = runtimeStatus.wechatReady === true;
      const fullReady = runtimeStatus.supervisorStatus === 'running' && qianfanReady && wechatReady;

      applyRuntimeHealth(runtimeStatus.health, runtimeStatus);
      if (state.runtimeRunning) startProgressDisplayTimer();

      if (fullReady) {
        state.relayStatus = 'running';
        state.qianfanStatus = 'ok';
        state.starting = false;
      } else if (runtimeStatus.supervisorStatus === 'starting') {
        state.starting = true;
      } else if (!running) {
        state.relayStatus = 'stopped';
        state.starting = false;
        stopProgressDisplayTimer();
      } else {
        state.relayStatus = 'attention';
        const listener = (runtimeStatus.workers || []).find((w) => w.workerName === 'qianfan-listener') || {};
        if (qianfanReady) state.qianfanStatus = 'ok';
        else if (listener.qianfanReady || listener.phase === 'qianfan_ready' || listener.phase === 'attached') {
          state.qianfanStatus = 'connecting';
        } else state.qianfanStatus = 'not_open';
        if (runtimeStatus.supervisorStatus !== 'starting') state.starting = false;
      }
      applyTodayStats(runtimeStatus.todayStats);
      renderAll();
    });
  }

  if (window.qianfanApp.onRuntimeStats) {
    unsubscribeRuntimeStats = window.qianfanApp.onRuntimeStats((stats) => {
      applyTodayStats(stats);
      renderCards();
    });
  }

  if (window.qianfanApp.onRuntimeLog) {
    unsubscribeRuntimeLog = window.qianfanApp.onRuntimeLog((entry) => {
      if (entry?.message) {
        state.lastMessage = String(entry.message).slice(0, 120);
        addRuntimeActivity(entry);
      }
    });
  }
}

async function init() {
  bindEvents();
  await loadAutoStart();
  await loadNotifiers();
  await refreshTodayStats();
  try {
    const version = await window.qianfanApp.getVersion();
    const paths = await window.qianfanApp.getPaths();
    els.advVersion.textContent = version || '-';
    els.advConfigDir.textContent = paths.configFile || paths.dataDir || '-';
    els.advLogsDir.textContent = paths.logsDir || '-';
  } catch {
    // ignore
  }
  renderAll();
  if (state.autoStart) {
    if (state.notifierCount > 0) {
      setTimeout(() => void handleStartRelay(), 800);
    } else {
      showToast('已开启自动启动，但尚未选择通知人，请先添加通知人');
    }
  }
}

init().catch((err) => {
  showToast(`界面初始化失败：${err.message}`);
});
