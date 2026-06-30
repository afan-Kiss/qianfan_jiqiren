const path = require('path');
const fs = require('fs');
const { ipcMain, shell, BrowserWindow } = require('electron');
const { resolveRuntimeRoot } = require('../shared/app-root');
const config = require('../wechat/wxbot-new-config');
const { reloadNotifyConfig, applyNotifyStateToConfig, buildNotifyState } = config;
const dataStore = require('../qianfan-data-store');
const { checkWxbotHealth } = require('../wxbot-new-health');
const { fetchDevToolsJsonList, getPageTargets } = require('../devtools-list');
const { sendWxText } = require('../wechat-send-api');
const { fetchWithTimeout } = require('../fetch-timeout');
const { RuntimeSupervisor } = require('../runtime/supervisor');
const { stopRuntimeChildProcesses } = require('../shared/runtime-process-cleanup');
const { formatActivityLogEntry } = require('../shared/activity-log');
const { formatLogTime } = require('../shared/user-activity-log');
const { isRoutineHealthActivityMessage } = require('../shared/runtime-health');
const { getLocalApiPort } = require('../qianfan-local-api');
const { runShopCookieUploadAll } = require('../shop-cookie-uploader');

const ROOT = config.root;
const CONFIG_FILE = path.join(ROOT, 'config.wxbot-new.json');

let runtimeSupervisor = null;
let statusPushBound = false;

function getPaths() {
  const logsDir = path.join(ROOT, 'logs');
  const dataDir = path.join(ROOT, 'data');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  return {
    rootDir: ROOT,
    dataDir,
    logsDir,
    configFile: CONFIG_FILE,
  };
}

async function preflightLaunchQianfanViaCmd() {
  const { createQianfanRuntimeController } = require('../adapters/qianfan-runtime-controller');

  const pushLog = (level, message) => {
    safePush('runtime:log', {
      level,
      message,
      workerName: 'qianfan-listener',
      time: Date.now(),
    });
  };

  const controller = createQianfanRuntimeController({
    config: { ...config.qianfanDebug, root: config.root },
    log: (level, message) => pushLog(level, message),
  });
  const result = await controller.ensureQianfanReady();

  if (!result.ok) {
    return { ok: false, lastError: result.lastError || '千帆未能自动启动' };
  }

  return { ok: true, ...result };
}

async function startRuntimeWithQianfanPreflight() {
  if (!fs.existsSync(config.wxbotExe)) {
    return { ok: false, status: 'failed', message: `未找到 wxbot.exe：${config.wxbotExe}` };
  }

  const supervisor = getSupervisor();
  const before = supervisor.getStatus();
  if (['starting', 'running', 'degraded'].includes(before.supervisorStatus)) {
    return {
      ok: true,
      status: before.supervisorStatus,
      message: 'runtime supervisor 已在运行',
      runtime: before,
      alreadyRunning: true,
    };
  }

  const qianfanResult = await preflightLaunchQianfanViaCmd();
  if (!qianfanResult.ok) {
    const message = qianfanResult.lastError || '千帆未能自动启动，请检查安装路径';
    return { ok: false, status: 'failed', message, qianfanResult };
  }

  const status = await supervisor.startAll();
  return {
    ok: true,
    status: 'starting',
    message: '千帆已启动，正在等待就绪后启动微信…',
    runtime: status,
    qianfanResult,
  };
}

function getSupervisor() {
  if (!runtimeSupervisor) {
    runtimeSupervisor = new RuntimeSupervisor({
      rootDir: ROOT,
      runtimeRoot: resolveRuntimeRoot(),
      logsDir: path.join(ROOT, 'logs'),
      workerExtraEnv: {
        'qianfan-listener': { QIANFAN_LAUNCH_BY_MAIN: '1' },
        'qianfan-sender': { QIANFAN_LAUNCH_BY_MAIN: '1' },
      },
    });
    bindSupervisorEvents(runtimeSupervisor);
  }
  return runtimeSupervisor;
}

function safePush(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // ignore renderer push failures
    }
  }
}

function bindSupervisorEvents(supervisor) {
  if (statusPushBound) return;
  statusPushBound = true;

  supervisor.on('status', (status) => {
    safePush('runtime:status:update', status);
    safePush('app:status-changed', status);
  });

  supervisor.on('log', (entry) => {
    if (isRoutineHealthActivityMessage(entry.message)) return;
    const formatted = formatActivityLogEntry(entry);
    if (!formatted.show) return;
    safePush('runtime:log', {
      ...entry,
      message: formatted.text,
      dedupKey: formatted.dedupKey,
      time: formatted.time || entry.time || Date.now(),
      displayTime: formatLogTime(formatted.time || entry.time || Date.now()),
    });
    if (/已通知微信|已成功回复千帆|回复千帆失败/.test(formatted.text)) {
      safePush('runtime:stats-update', dataStore.getTodayStats());
    }
  });
}

function syncSupervisorNotifyCount() {
  applyNotifyStateToConfig(config, buildNotifyState());
  const count = (config.notifyAccounts || []).filter((item) => item && String(item.wxid || '').trim()).length;
  getSupervisor().setNotifyAccountCount(count);
  return count;
}

function getRuntimeStatus() {
  syncSupervisorNotifyCount();
  return getSupervisor().getStatus();
}

function mapRuntimeToLegacyStatus(runtimeStatus) {
  const workers = runtimeStatus?.workers || [];
  const health = runtimeStatus?.health || null;
  const byName = Object.fromEntries(workers.map((w) => [w.name || w.workerName, w]));
  const listener = byName['qianfan-listener'] || {};
  const callback = byName['wechat-callback'] || {};
  const running = ['running', 'starting', 'degraded', 'restarting'].includes(runtimeStatus.supervisorStatus);
  const wechatReady = callback.status === 'running' || callback.businessReady === true;
  const qianfanReady = listener.qianfanReady === true && listener.listenerReady === true;
  const fullReady = runtimeStatus.supervisorStatus === 'running' && wechatReady && qianfanReady;

  return {
    bot: {
      running,
      starting: runtimeStatus.supervisorStatus === 'starting',
      fullReady,
      partialReady: running,
      wechatReady,
      qianfanReady,
      bootWaiting: running && !wechatReady,
      bootStatus: fullReady ? 'ready' : running ? 'waiting_login' : 'stopped',
      degraded: runtimeStatus.supervisorStatus === 'degraded' || (running && !qianfanReady),
      qianfanPhase: listener.phase || listener.qianfanRuntime?.phase || '',
      qianfanError: listener.lastError || listener.qianfanRuntime?.lastError || '',
      relayRunning: health?.relayRunning === true || running,
    },
    modules: {
      'wechat-runtime': {
        status: callback.status === 'running' ? 'running' : running ? 'waiting_manual' : 'stopped',
        businessReady: wechatReady,
      },
      'qianfan-listener': {
        status: qianfanReady ? 'running' : listener.status === 'degraded' ? 'degraded' : listener.status === 'failed' ? 'failed' : 'stopped',
        businessReady: qianfanReady,
        qianfanReady: listener.qianfanReady === true,
        listenerReady: listener.listenerReady === true,
        phase: listener.phase || '',
        lastError: listener.lastError || listener.reason || '',
      },
    },
    runtime: runtimeStatus,
    health,
    todayStats: dataStore.getTodayStats(),
  };
}

function readNotifyAccountsFromConfig() {
  applyNotifyStateToConfig(config, buildNotifyState());
  return (config.notifyAccounts || [])
    .filter((a) => a && String(a.wxid || '').trim())
    .map((a) => ({
      wxid: String(a.wxid).trim(),
      nickname: a.name || a.wxid,
      wechatNo: a.wechatNo || '',
      remark: a.wechatNo || '',
      avatar: String(a.avatar || '').trim(),
      notifyEnabled: a.notifyEnabled !== false,
      replyEnabled: a.replyEnabled !== false,
    }));
}

function writeNotifyAccountsToFile(accounts) {
  let fileCfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      fileCfg = {};
    }
  }
  fileCfg.notifyAccounts = (accounts || []).map((a, index) => ({
    key: String(index + 1),
    name: a.nickname || a.name || a.wxid,
    wxid: a.wxid,
    wechatNo: a.wechatNo || a.remark || '',
    avatar: String(a.avatar || '').trim(),
    notifyEnabled: a.notifyEnabled !== false,
    replyEnabled: a.replyEnabled !== false,
  }));
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(fileCfg, null, 2)}\n`, 'utf8');
  applyNotifyStateToConfig(config, buildNotifyState(loadFileConfigFromDisk()));
  reloadNotifyConfig(true);
  return readNotifyAccountsFromConfig();
}

function loadFileConfigFromDisk() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function authHeaders(extra = {}) {
  const headers = { Accept: 'application/json', ...extra };
  if (config.username && config.password) {
    headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  }
  return headers;
}

async function fetchWxbotJson(url, options = {}, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, { ...options, headers: authHeaders(options.headers || {}) }, timeoutMs);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { ok: res.ok, status: res.status, body };
}

function normalizeAvatarUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value.startsWith('data:')) return value;
  if (value.startsWith('//')) return `https:${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  return '';
}

async function fetchAvatarDataUrl(url) {
  const normalized = normalizeAvatarUrl(url);
  if (!normalized) return '';
  if (normalized.startsWith('data:')) return normalized;
  try {
    const res = await fetchWithTimeout(normalized, {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: '',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    }, 10000);
    if (!res.ok) return '';
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) return '';
    const contentType = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim() || 'image/jpeg';
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch {
    return '';
  }
}

function normalizeWxbotFriend(item) {
  const wxid = String(item?.wxid || item?.userName || item?.username || '').trim();
  if (!wxid) return null;
  const wechatNo = String(item?.account || item?.wechatNo || item?.wechatId || '').trim();
  return {
    wxid,
    nickname: String(item?.nickname || item?.nickName || item?.name || wxid).trim(),
    wechatNo,
    remark: String(item?.remark || item?.alias || '').trim(),
    avatar: normalizeAvatarUrl(item?.avatar || item?.headImgUrl || item?.headimgurl || item?.smallHeadImgUrl || ''),
  };
}

function extractFriendListFromWxbotBody(body) {
  const data = body?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.contacts)) return data.contacts;
  if (Array.isArray(data?.friends)) return data.friends;
  if (Array.isArray(body?.list)) return body.list;
  if (Array.isArray(body?.contacts)) return body.contacts;
  if (Array.isArray(body?.friends)) return body.friends;
  return [];
}

async function listWechatFriendsFromWxbot() {
  const base = config.baseUrl.replace(/\/$/, '');
  const endpoints = [
    '/api/wechat/friend-list',
    '/api/wechat/friend/list',
    '/api/wechat/friends',
    '/api/wechat/contact/list',
    '/api/wechat/contacts',
    '/api/contact/list',
  ];
  const failures = [];

  for (const endpoint of endpoints) {
    try {
      const result = await fetchWxbotJson(`${base}${endpoint}`, {}, 15000);
      const body = result.body || {};
      const apiOk = result.ok && (body.code === 0 || body.code === undefined);
      if (!apiOk) {
        failures.push(`${endpoint}: ${body.message || `HTTP ${result.status}`}`);
        continue;
      }
      const rawList = extractFriendListFromWxbotBody(body);
      if (!rawList.length) {
        failures.push(`${endpoint}: 空列表`);
        continue;
      }
      const friends = rawList.map(normalizeWxbotFriend).filter(Boolean);
      if (!friends.length) {
        failures.push(`${endpoint}: 无有效 wxid`);
        continue;
      }
      return { ok: true, friends, endpoint };
    } catch (err) {
      failures.push(`${endpoint}: ${err.message || err}`);
    }
  }

  return {
    ok: false,
    friends: [],
    message: failures.length
      ? `未能读取微信好友（已尝试 ${endpoints.length} 个接口）`
      : '未能读取微信好友',
    failures,
  };
}

function readUiPreferences() {
  if (!fs.existsSync(CONFIG_FILE)) return { autoStart: false };
  try {
    const fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { autoStart: fileCfg.ui?.autoStart === true };
  } catch {
    return { autoStart: false };
  }
}

function writeAutoStartPreference(enabled) {
  let fileCfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      fileCfg = {};
    }
  }
  fileCfg.ui = { ...(fileCfg.ui || {}), autoStart: Boolean(enabled) };
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(fileCfg, null, 2)}\n`, 'utf8');
  return readUiPreferences();
}

async function checkQianfanDevTools() {
  const { probeDevTools } = require('../qianfan-client-launcher');
  const { createQianfanRuntimeController } = require('../adapters/qianfan-runtime-controller');
  const qianfanCfg = config.qianfanDebug || {};
  const controller = createQianfanRuntimeController({ config: qianfanCfg });
  const clientConfig = controller.getConfig();
  try {
    const probe = await probeDevTools(clientConfig);
    if (probe.ok) {
      const pages = getPageTargets(probe.list || []);
      return {
        ok: pages.length > 0,
        pageCount: pages.length,
        status: pages.length > 0 ? 'running' : 'degraded',
        message: pages.length > 0
          ? `已检测到 ${pages.length} 个千帆页面`
          : '千帆调试端口已连通，但还没有检测到店铺页面',
        devtoolsReady: true,
      };
    }
    const { buildQianfanAttachHint } = require('../adapters/qianfan-runtime-controller');
    const message = buildQianfanAttachHint(clientConfig, probe);
    return {
      ok: false,
      pageCount: 0,
      status: 'not_open',
      message,
      devtoolsReady: false,
    };
  } catch (err) {
    return {
      ok: false,
      pageCount: 0,
      status: 'not_open',
      message: err.message || '千帆 DevTools 不可用',
      devtoolsReady: false,
    };
  }
}

function isRuntimeRunning() {
  const status = getRuntimeStatus();
  return ['starting', 'running', 'degraded'].includes(status.supervisorStatus);
}

async function uploadShopCookiesViaLocalApiOrDirect() {
  const port = getLocalApiPort();
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/api/shop-cookies/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, 35000);
    const data = await res.json().catch(() => ({}));
    if (res.ok || res.status === 503) {
      return { ...data, source: 'local_api' };
    }
  } catch {
    // worker 本地 API 未就绪时，主进程直接通过 CDP 采集并上传
  }

  const result = await runShopCookieUploadAll('ui_manual', {
    useDevToolsFallback: true,
    verifyStatus: true,
  });
  return { ...result, source: 'main_cdp' };
}

function registerIpcHandlers(app) {
  ipcMain.handle('app:get-version', () => app.getVersion());
  ipcMain.handle('app:get-paths', () => getPaths());
  ipcMain.handle('app:ping', async () => ({
    ok: true,
    message: 'pong',
    timestamp: new Date().toISOString(),
  }));

  ipcMain.handle('app:open-config-dir', async () => {
    await shell.openPath(path.dirname(CONFIG_FILE));
    return path.dirname(CONFIG_FILE);
  });

  ipcMain.handle('app:open-logs-dir', async () => {
    const paths = getPaths();
    await shell.openPath(paths.logsDir);
    return paths.logsDir;
  });

  ipcMain.handle('runtime:start', async () => startRuntimeWithQianfanPreflight());

  ipcMain.handle('runtime:stop', async (_event, reason) => {
    const status = await getSupervisor().stopAll(reason || 'manual');
    return { ok: true, status };
  });

  ipcMain.handle('runtime:restart-worker', async (_event, workerName) => {
    const result = await getSupervisor().restartWorker(workerName, 'manual', { manual: true });
    return { ok: true, result };
  });

  ipcMain.handle('runtime:status', async () => getRuntimeStatus());

  ipcMain.handle('app:get-notify-accounts', async () => readNotifyAccountsFromConfig());
  ipcMain.handle('app:set-notify-accounts', async (_event, accounts) => {
    const saved = writeNotifyAccountsToFile(Array.isArray(accounts) ? accounts : []);
    if (isRuntimeRunning()) {
      try {
        await getSupervisor().restartWorker('wechat-notifier', 'notify_accounts_updated', { manual: true });
        await getSupervisor().restartWorker('wechat-reply', 'notify_accounts_updated', { manual: true });
      } catch {
        // ignore; live config reload still applies on next message
      }
    }
    return saved;
  });
  ipcMain.handle('app:get-ui-preferences', async () => readUiPreferences());
  ipcMain.handle('app:set-auto-start', async (_event, enabled) => writeAutoStartPreference(Boolean(enabled)));

  ipcMain.handle('app:wechat-health', async () => {
    const report = await checkWxbotHealth();
    return {
      ok: report.ok,
      message: report.brief || report.reason || (report.ok ? '微信正常' : '微信未就绪'),
      report,
    };
  });

  ipcMain.handle('app:list-wechat-friends', async () => listWechatFriendsFromWxbot());
  ipcMain.handle('app:fetch-avatar-data-url', async (_event, url) => fetchAvatarDataUrl(url));

  ipcMain.handle('app:send-test-wechat-message', async (_event, wxid) => {
    try {
      const target = String(wxid || '').trim();
      if (!target) return { ok: false, message: '缺少 wxid' };
      await sendWxText(target, '【千帆客服台机器人】这是一条测试通知。');
      return { ok: true, message: '测试通知已发送' };
    } catch (err) {
      return { ok: false, message: err.message || '发送失败' };
    }
  });

  ipcMain.handle('app:send-test-message', async (_event, wxid) => {
    try {
      const target = String(wxid || '').trim();
      if (!target) return { ok: false, message: '缺少 wxid' };
      await sendWxText(target, '【千帆客服台机器人】这是一条测试通知。');
      return { ok: true, message: '测试通知已发送' };
    } catch (err) {
      return { ok: false, message: err.message || '发送失败' };
    }
  });

  ipcMain.handle('app:ensure-wechat-ready', async () => {
    const report = await checkWxbotHealth();
    if (report.ok) return { ok: true, message: '微信已就绪', status: 'ready', steps: [] };
    if (report.apiOk && !report.injectOk) {
      return { ok: false, waiting: true, status: 'waiting_login', message: report.reason || '请扫码登录微信', steps: [] };
    }
    return { ok: false, status: 'failed', message: report.reason || report.brief || '微信助手未就绪，请先启动中转', steps: [] };
  });

  ipcMain.handle('app:prepare-wechat-runtime', async () => ({
    ok: false,
    message: '请使用「启动中转」启动 runtime supervisor',
    steps: [],
  }));

  ipcMain.handle('app:start-relay', async () => startRuntimeWithQianfanPreflight());

  ipcMain.handle('app:stop-relay', async () => {
    const status = await getSupervisor().stopAll('manual');
    return { ok: true, status, stopped: true };
  });

  ipcMain.handle('app:start-bot', async () => startRuntimeWithQianfanPreflight());

  ipcMain.handle('app:stop-bot', async () => {
    const status = await getSupervisor().stopAll('manual');
    return { ok: true, status, stopped: true };
  });

  ipcMain.handle('app:get-relay-state', async () => {
    const runtimeStatus = getRuntimeStatus();
    const running = isRuntimeRunning();
    const fullReady = runtimeStatus.supervisorStatus === 'running'
      && runtimeStatus.qianfanReady
      && runtimeStatus.wechatReady;
    return {
      running,
      starting: runtimeStatus.supervisorStatus === 'starting',
      fullReady,
      partialReady: running,
      degraded: runtimeStatus.supervisorStatus === 'degraded',
      qianfanReady: runtimeStatus.qianfanReady === true,
      status: runtimeStatus.supervisorStatus,
    };
  });

  ipcMain.handle('app:get-status', async () => mapRuntimeToLegacyStatus(getRuntimeStatus()));

  ipcMain.handle('app:check-environment', async () => {
    const issues = [];
    const wechatReport = await checkWxbotHealth();
    const qianfan = await checkQianfanDevTools();

    if (!fs.existsSync(config.wxbotExe)) issues.push(`缺少 wxbot.exe：${config.wxbotExe}`);
    if (!wechatReport.apiOk) issues.push('wxbot API 未响应，请先启动中转');
    else if (!wechatReport.injectOk) issues.push(wechatReport.reason || '微信尚未注入或未登录');
    else if (!wechatReport.ok) issues.push(wechatReport.reason || '微信登录状态异常');
    if (!fs.existsSync(config.qianfanDebug.qianfanClientExePath)) {
      issues.push(`未找到千帆客服工作台：${config.qianfanDebug.qianfanClientExePath}`);
    }
    if (!qianfan.ok) issues.push(qianfan.message || '千帆 DevTools 未连接');

    return {
      ok: issues.length === 0,
      issueCount: issues.length,
      issues,
      wechat: {
        ok: wechatReport.ok,
        stage: !wechatReport.apiOk ? 'api' : !wechatReport.injectOk ? 'login' : wechatReport.ok ? 'ready' : 'error',
        report: wechatReport,
      },
      qianfanListener: qianfan,
      modules: {
        'qianfan-listener': qianfan,
        'wechat-runtime': {
          status: wechatReport.ok ? 'running' : 'stopped',
          businessReady: wechatReport.ok,
        },
      },
    };
  });

  ipcMain.handle('app:get-relay-logs', async () => getRuntimeStatus().recentLogs.slice(-80));

  ipcMain.handle('app:get-today-stats', async () => dataStore.getTodayStats());

  ipcMain.handle('app:upload-shop-cookies', async () => {
    try {
      const result = await uploadShopCookiesViaLocalApiOrDirect();
      return result;
    } catch (err) {
      return {
        ok: false,
        message: err.message || 'Cookie 提交失败',
        shops: [],
        success: 0,
        failed: 4,
        total: 4,
      };
    }
  });
}

async function stopBackendServices() {
  process.env.QIANFAN_RUNTIME_SHUTTING_DOWN = '1';
  if (runtimeSupervisor) {
    await runtimeSupervisor.stopAll('app-quit');
    runtimeSupervisor.dispose();
    runtimeSupervisor = null;
    statusPushBound = false;
  }
  await stopRuntimeChildProcesses({ reason: 'app-quit', killQianfan: false });
}

module.exports = {
  registerIpcHandlers,
  stopBackendServices,
  getSupervisor,
};
