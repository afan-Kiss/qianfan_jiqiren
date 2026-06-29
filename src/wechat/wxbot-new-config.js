/**
 * wxbot-new 配置（环境变量可覆盖 config.wxbot-new.json）
 * 内置固定账号关系，缺失或为空时自动补全，无需手动填写 wxid
 */
const fs = require('fs');
const path = require('path');
const {
  resolveProjectRoot,
  resolveWxbotRuntimeDir,
} = require('../shared/app-root');
const { resolveQianfanClientPaths } = require('../shared/qianfan-path-detect');

const ROOT = resolveProjectRoot();
const CONFIG_FILE = path.join(ROOT, 'config.wxbot-new.json');

const DEFAULT_KNOWN_ACCOUNTS = {
  robot: {
    name: '饭饭',
    wechatNo: 'fanfansanhao0824',
    wxid: 'wxid_ddke8w2dtkcp22',
    role: 'robot_login',
  },
  notifyReceiver: {
    name: '饭饭',
    wechatNo: 'fanfanerhao0824',
    wxid: 'wxid_jr6nn7q8lezg12',
    role: 'notify_and_reply',
  },
};

const DEFAULT_NOTIFY_ACCOUNTS = [
  {
    name: '二号',
    wechatNo: 'fanfanerhao0824',
    wxid: 'wxid_jr6nn7q8lezg12',
    notifyEnabled: true,
    replyEnabled: true,
  },
];

function envBool(name, defaultVal) {
  const v = process.env[name];
  if (v == null || v === '') return defaultVal;
  return v === '1' || String(v).toLowerCase() === 'true' || String(v).toLowerCase() === 'yes';
}

function loadFileConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function pickNonEmpty(...values) {
  for (const v of values) {
    if (v == null) continue;
    const s = typeof v === 'string' ? v.trim() : v;
    if (s !== '' && s != null) return s;
  }
  return '';
}

function mergeAccount(base, override) {
  const o = override && typeof override === 'object' ? override : {};
  return {
    name: pickNonEmpty(o.name, base.name),
    wechatNo: pickNonEmpty(o.wechatNo, o.wechatId, base.wechatNo),
    wxid: pickNonEmpty(o.wxid, base.wxid),
    role: pickNonEmpty(o.role, base.role),
  };
}

function resolveKnownAccounts(fileKnown) {
  const src = fileKnown && typeof fileKnown === 'object' ? fileKnown : {};
  return {
    robot: mergeAccount(DEFAULT_KNOWN_ACCOUNTS.robot, src.robot),
    notifyReceiver: mergeAccount(DEFAULT_KNOWN_ACCOUNTS.notifyReceiver, src.notifyReceiver),
  };
}

function resolveNotifyAccounts(fileAccounts, knownAccounts) {
  const receiver = knownAccounts.notifyReceiver;
  const defaultEntry = {
    name: '二号',
    wechatNo: receiver.wechatNo,
    wxid: receiver.wxid,
    notifyEnabled: true,
    replyEnabled: true,
  };

  if (!Array.isArray(fileAccounts) || !fileAccounts.length) {
    return [{ ...defaultEntry, key: '1' }];
  }

  const merged = fileAccounts.map((acc, i) => {
    const a = acc && typeof acc === 'object' ? acc : {};
    const wxid = String(a.wxid || '').trim();
    const matchesReceiver = wxid === receiver.wxid;
    const base = matchesReceiver
      ? defaultEntry
      : {
          name: pickNonEmpty(a.name, `账号${i + 1}`),
          wechatNo: pickNonEmpty(a.wechatNo, a.wechatId, ''),
          wxid,
          notifyEnabled: true,
          replyEnabled: true,
        };

    return {
      key: pickNonEmpty(a.key, String(i + 1)),
      name: pickNonEmpty(a.name, base.name),
      wechatNo: pickNonEmpty(a.wechatNo, a.wechatId, base.wechatNo, matchesReceiver ? receiver.wechatNo : ''),
      wxid: pickNonEmpty(wxid, base.wxid),
      notifyEnabled: a.notifyEnabled !== undefined ? a.notifyEnabled !== false : base.notifyEnabled !== false,
      replyEnabled: a.replyEnabled !== undefined ? a.replyEnabled !== false : base.replyEnabled !== false,
    };
  });

  return merged;
}

function getNotifyTargets(notifyAccounts, knownAccounts) {
  const receiver = knownAccounts.notifyReceiver;
  const enabled = (Array.isArray(notifyAccounts) ? notifyAccounts : []).filter(
    (a) => a && a.notifyEnabled !== false && String(a.wxid || '').trim()
  );

  if (enabled.length) {
    return enabled.map((a) => ({
      name: pickNonEmpty(a.name, '二号'),
      wechatNo: pickNonEmpty(a.wechatNo, receiver.wechatNo),
      wxid: String(a.wxid).trim(),
      replyEnabled: a.replyEnabled !== false,
    }));
  }

  return [
    {
      name: '二号',
      wechatNo: receiver.wechatNo,
      wxid: receiver.wxid,
      replyEnabled: true,
    },
  ];
}

function buildNotifyState(fileCfg = loadFileConfig()) {
  const wx = fileCfg.wxbotNew || fileCfg.wxbot_new || {};
  const known = resolveKnownAccounts(fileCfg.knownAccounts);
  const accounts = resolveNotifyAccounts(
    Array.isArray(fileCfg.notifyAccounts)
      ? fileCfg.notifyAccounts
      : Array.isArray(wx.notifyAccounts)
        ? wx.notifyAccounts
        : [],
    known,
  );
  const targets = getNotifyTargets(accounts, known);
  const authorizedReplyWxids = targets
    .filter((t) => t.replyEnabled !== false && String(t.wxid || '').trim())
    .map((t) => String(t.wxid).trim());
  return { notifyAccounts: accounts, notifyTargets: targets, authorizedReplyWxids, knownAccounts: known };
}

let notifyConfigCacheMtime = 0;

function applyNotifyStateToConfig(targetConfig, state) {
  if (!targetConfig || !state) return targetConfig;
  targetConfig.notifyAccounts = state.notifyAccounts;
  targetConfig.notifyTargets = state.notifyTargets;
  targetConfig.authorizedReplyWxids = state.authorizedReplyWxids;
  targetConfig.authorizedReplyWxid =
    state.authorizedReplyWxids[0] || targetConfig.notifyReceiverAccount?.wxid || '';
  return targetConfig;
}

function reloadNotifyConfig(force = false) {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  const mtime = fs.statSync(CONFIG_FILE).mtimeMs;
  if (!force && mtime === notifyConfigCacheMtime) return null;
  notifyConfigCacheMtime = mtime;
  const fresh = buildNotifyState();
  applyNotifyStateToConfig(config, fresh);
  return fresh;
}

function getLiveNotifyTargets() {
  reloadNotifyConfig();
  return Array.isArray(config.notifyTargets) ? config.notifyTargets : [];
}

function getAuthorizedReplyWxids() {
  getLiveNotifyTargets();
  if (Array.isArray(config.authorizedReplyWxids) && config.authorizedReplyWxids.length) {
    return config.authorizedReplyWxids;
  }
  const wxid = config.authorizedReplyWxid || config.notifyReceiverAccount?.wxid;
  return wxid ? [String(wxid).trim()] : [];
}

function isAuthorizedReplyWxid(wxid) {
  const id = String(wxid || '').trim();
  if (!id) return false;
  return getAuthorizedReplyWxids().includes(id);
}

function findNotifyTargetByRecipient(to) {
  const recipient = String(to || '').trim();
  if (!recipient) return null;
  for (const target of getLiveNotifyTargets()) {
    if (recipient === String(target.wxid || '').trim()) return target;
    if (target.wechatNo && recipient === String(target.wechatNo).trim()) return target;
  }
  return null;
}

const fileCfg = loadFileConfig();
const wx = fileCfg.wxbotNew || fileCfg.wxbot_new || {};

function pick(key, fallback = '') {
  const v = pickNonEmpty(fileCfg[key], wx[key], fallback);
  return v === '' ? fallback : v;
}

function pickNum(key, fallback) {
  const v = pick(key, fallback);
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const knownAccounts = resolveKnownAccounts(fileCfg.knownAccounts);
const notifyAccounts = resolveNotifyAccounts(
  Array.isArray(fileCfg.notifyAccounts)
    ? fileCfg.notifyAccounts
    : Array.isArray(wx.notifyAccounts)
      ? wx.notifyAccounts
      : [],
  knownAccounts
);
const notifyTargets = getNotifyTargets(notifyAccounts, knownAccounts);
const authorizedReplyWxids = notifyTargets
  .filter((t) => t.replyEnabled !== false && String(t.wxid || '').trim())
  .map((t) => String(t.wxid).trim());
if (fs.existsSync(CONFIG_FILE)) {
  notifyConfigCacheMtime = fs.statSync(CONFIG_FILE).mtimeMs;
}

const oneClickFile = fileCfg.oneClick || wx.oneClick || {};
const qianfanDebugFile = fileCfg.qianfanDebug || {};
const resolvedQianfanPaths = resolveQianfanClientPaths(fileCfg);
const qianfanDebug = {
  enabled: qianfanDebugFile.enabled !== false,
  devtoolsPort: pickNum('devtoolsPort', qianfanDebugFile.devtoolsPort || fileCfg.qianfanDevtoolsPort || 9322),
  devtoolsHost: qianfanDebugFile.devtoolsHost || '127.0.0.1',
  browserExePath: String(qianfanDebugFile.browserExePath || '').trim(),
  userDataDir: qianfanDebugFile.userDataDir || 'runtime/qianfan-debug-profile',
  qianfanClientExePath: String(qianfanDebugFile.qianfanClientExePath || resolvedQianfanPaths.qianfanClientExePath).trim(),
  qianfanClientWorkingDir: String(qianfanDebugFile.qianfanClientWorkingDir || resolvedQianfanPaths.qianfanClientWorkingDir).trim(),
  qianfanClientProcessName: String(qianfanDebugFile.qianfanClientProcessName || '千帆客服工作台.exe').trim(),
  autoLaunchQianfanClientWhenMissing: qianfanDebugFile.autoLaunchQianfanClientWhenMissing !== false,
  autoCloseExistingQianfanClient: qianfanDebugFile.autoCloseExistingQianfanClient !== false,
  expectedShopCount: pickNum('expectedShopCount', qianfanDebugFile.expectedShopCount || 4),
  qianfanClientArgs: Array.isArray(qianfanDebugFile.qianfanClientArgs) ? qianfanDebugFile.qianfanClientArgs : undefined,
  urls:
    Array.isArray(qianfanDebugFile.urls) && qianfanDebugFile.urls.length
      ? qianfanDebugFile.urls
      : ['https://edith.xiaohongshu.com', 'https://walle.xiaohongshu.com/cstools/seller/dashboard'],
  waitTimeoutMs: pickNum('waitTimeoutMs', qianfanDebugFile.waitTimeoutMs || 60000),
  checkIntervalMs: pickNum('checkIntervalMs', qianfanDebugFile.checkIntervalMs || 2000),
  sameErrorPrintIntervalMs: pickNum(
    'sameErrorPrintIntervalMs',
    qianfanDebugFile.sameErrorPrintIntervalMs || 10000
  ),
  wsWakeBuyerNick: String(qianfanDebugFile.wsWakeBuyerNick || '饭饭').trim(),
  wsWakeText: String(qianfanDebugFile.wsWakeText || '亲亲').trim() || '亲亲',
  sendOnlyBuyerNick:
    process.env.QIANFAN_SEND_ONLY_BUYER_NICK !== undefined
      ? String(process.env.QIANFAN_SEND_ONLY_BUYER_NICK).trim()
      : Object.prototype.hasOwnProperty.call(qianfanDebugFile, 'sendOnlyBuyerNick')
        ? String(qianfanDebugFile.sendOnlyBuyerNick || '').trim()
        : '饭饭',
  root: ROOT,
};

const controlCenterFile = fileCfg.controlCenter || {};
const controlCenter = {
  enabled: controlCenterFile.enabled !== false,
  serverUrl: String(process.env.CONTROL_SERVER_URL || controlCenterFile.serverUrl || 'http://8.137.126.18/control').replace(/\/$/, ''),
  serviceToken: String(process.env.CONTROL_SERVICE_TOKEN || controlCenterFile.serviceToken || '').trim(),
  collectorMachine: String(process.env.CONTROL_COLLECTOR_MACHINE || controlCenterFile.collectorMachine || '培育钻石').trim(),
  collectorProject: String(controlCenterFile.collectorProject || '千帆中转机器人').trim(),
  uploadIntervalMinutes: pickNum('controlCenterUploadIntervalMinutes', controlCenterFile.uploadIntervalMinutes || 10),
};

const loginBotWxid =
  process.env.WXBOT_LOGIN_BOT_WXID || pick('loginBotWxid', knownAccounts.robot.wxid);

const config = {
  wechatProvider: process.env.WECHAT_PROVIDER || fileCfg.wechatProvider || 'wxbot_new',
  enabled: envBool('WXBOT_NEW_ENABLED', wx.enabled !== false),
  baseUrl: process.env.WXBOT_NEW_BASE_URL || pick('baseUrl', 'http://127.0.0.1:5000'),
  loginBotWxid,
  callbackPath: pick('callbackPath', '/wechat/wxbot-new/callback'),
  callbackUrl: pick('callbackUrl', 'http://127.0.0.1:8787/wechat/wxbot-new/callback'),
  callbackPort: pickNum('callbackPort', 8787),
  startupMode: pick('startupMode', 'manual_wxbot_exe'),
  debugVerbose: envBool('WXBOT_DEBUG_VERBOSE', pick('debugVerbose', false)),
  dryRun: envBool('WXBOT_NEW_DRY_RUN', wx.dryRun === true),
  testSendWxid: pick('testSendWxid', ''),
  readyNotifyWxid: pick('readyNotifyWxid', 'filehelper'),
  readyNotifyText:
    pick(
      'readyNotifyText',
      '【千帆客服台机器人】\n微信底座已准备就绪。\n当前阶段：微信注入 / 回调 / 发送测试已打通。\n现在可以接收微信回调消息。'
    ),
  knownAccounts,
  robotAccount: knownAccounts.robot,
  notifyReceiverAccount: knownAccounts.notifyReceiver,
  authorizedReplyWxid: authorizedReplyWxids[0] || knownAccounts.notifyReceiver.wxid,
  authorizedReplyWxids,
  notifyTargets,
  oneClick: {
    autoKillExistingWechat: oneClickFile.autoKillExistingWechat !== false,
    healthCheckIntervalMs: pickNum('healthCheckIntervalMs', oneClickFile.healthCheckIntervalMs || 2000),
    sameErrorPrintIntervalMs: pickNum(
      'sameErrorPrintIntervalMs',
      oneClickFile.sameErrorPrintIntervalMs || 10000
    ),
    mergeWindowMs: pickNum('mergeWindowMs', oneClickFile.mergeWindowMs || 3000),
  },
  notifyAccounts,
  qianfanDevtoolsPort: qianfanDebug.devtoolsPort,
  qianfanDebug,
  controlCenter,
  username: pick('username', wx.username || ''),
  password: pick('password', wx.password || ''),
  wxbotRuntimeDir: resolveWxbotRuntimeDir(ROOT),
  wxbotExe: path.join(resolveWxbotRuntimeDir(ROOT), 'wxbot.exe'),
  root: ROOT,
};

module.exports = config;
module.exports.getNotifyTargets = getNotifyTargets;
module.exports.getLiveNotifyTargets = getLiveNotifyTargets;
module.exports.reloadNotifyConfig = reloadNotifyConfig;
module.exports.applyNotifyStateToConfig = applyNotifyStateToConfig;
module.exports.buildNotifyState = buildNotifyState;
module.exports.getAuthorizedReplyWxids = getAuthorizedReplyWxids;
module.exports.isAuthorizedReplyWxid = isAuthorizedReplyWxid;
module.exports.findNotifyTargetByRecipient = findNotifyTargetByRecipient;
module.exports.resolveKnownAccounts = resolveKnownAccounts;
module.exports.DEFAULT_KNOWN_ACCOUNTS = DEFAULT_KNOWN_ACCOUNTS;
