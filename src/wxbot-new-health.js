/**
 * wxbot-new 注入与健康检测（仅检测 API，不启动/不注入微信）
 */
const config = require('./wechat/wxbot-new-config');
const { fetchWithTimeout } = require('./fetch-timeout');

function authHeaders() {
  const headers = { Accept: 'application/json' };
  if (config.username && config.password) {
    const token = Buffer.from(`${config.username}:${config.password}`).toString('base64');
    headers.Authorization = `Basic ${token}`;
  }
  return headers;
}

async function fetchJson(url, options = {}, timeoutMs = 5000) {
  const res = await fetchWithTimeout(
    url,
    {
      ...options,
      headers: { ...authHeaders(), ...(options.headers || {}) },
    },
    timeoutMs
  );
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { ok: res.ok, status: res.status, body };
}

function extractWxidFromLoginBody(body) {
  const data = body?.data || body || {};
  return String(data.wxid || data.userName || data.username || data.UserName || data.account || '').trim();
}

function extractNicknameFromLoginBody(body) {
  const data = body?.data || body || {};
  return String(data.nickname || data.Nickname || data.nickName || data.name || '').trim();
}

function briefReason(report) {
  if (report.reason) return report.reason;
  if (!report.apiOk) return 'wxbot API 未响应';
  if (!report.injectOk) return '等待扫码或注入中';
  if (report.wxid && config.loginBotWxid && report.wxid !== config.loginBotWxid) {
    return '登录 wxid 与配置不一致';
  }
  return '等待扫码/注入中';
}

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   apiOk: boolean,
 *   injectOk: boolean,
 *   wxid: string,
 *   nickname: string,
 *   reason: string,
 *   brief: string,
 *   statusMessage?: string,
 *   clientId?: number,
 *   connectedCount?: number,
 * }>}
 */
async function checkWxbotHealth() {
  const report = {
    ok: false,
    apiOk: false,
    injectOk: false,
    wxid: '',
    nickname: '',
    reason: '',
    brief: '',
  };

  let health;
  try {
    health = await fetchJson(`${config.baseUrl.replace(/\/$/, '')}/health`);
  } catch (err) {
    report.reason = `无法连接 wxbot-new：${err.message || err}`;
    report.brief = '等待 wxbot.exe 启动';
    return report;
  }

  if (!health.ok) {
    report.reason = `/health 异常 HTTP ${health.status}`;
    report.brief = '等待 wxbot.exe 启动';
    return report;
  }

  report.apiOk = true;

  let status;
  try {
    status = await fetchJson(`${config.baseUrl.replace(/\/$/, '')}/api/wechat/status`);
  } catch (err) {
    report.reason = `status 请求失败：${err.message || err}`;
    report.brief = briefReason(report);
    return report;
  }

  const statusData = status.body?.data || status.body || {};
  report.statusMessage = String(statusData.message || '');
  report.clientId = Number(statusData.client_id || 0);
  report.connectedCount = Number(statusData.connected_count || 0);

  if (!statusData.running || !report.clientId) {
    report.reason = report.statusMessage || '微信服务未注入或未连接';
    report.brief = briefReason(report);
    return report;
  }

  report.injectOk = true;

  let login;
  try {
    login = await fetchJson(`${config.baseUrl.replace(/\/$/, '')}/api/wechat/login-info`);
  } catch (err) {
    report.reason = `login-info 请求失败：${err.message || err}`;
    report.brief = briefReason(report);
    return report;
  }

  if (!login.ok || login.body?.code !== 0) {
    report.reason = login.body?.message || '尚未登录微信';
    report.injectOk = false;
    report.brief = briefReason(report);
    return report;
  }

  report.wxid = extractWxidFromLoginBody(login.body);
  report.nickname = extractNicknameFromLoginBody(login.body);

  if (!report.wxid) {
    report.reason = 'login-info 未返回 wxid，可能尚未扫码登录';
    report.injectOk = false;
    report.brief = briefReason(report);
    return report;
  }

  if (config.loginBotWxid && report.wxid !== config.loginBotWxid) {
    report.wrongLoginWxid = true;
    report.reason = `登录 wxid=${report.wxid} 与配置 loginBotWxid 不一致`;
    report.brief = briefReason(report);
    return report;
  }

  report.ok = true;
  report.reason = '';
  report.brief = '注入正常';
  return report;
}

function formatCheckLines(report) {
  const lines = [];
  lines.push(`wxbot-new API：${report.apiOk ? '正常' : '异常'}`);
  lines.push(`注入状态：${report.injectOk ? '正常' : '未就绪'}`);
  if (report.wxid) {
    const name = report.nickname ? `${report.nickname} ` : '';
    lines.push(`当前登录：${name}${report.wxid}`);
  }
  if (!report.ok && report.reason) lines.push(`原因：${report.reason}`);
  return lines;
}

module.exports = {
  checkWxbotHealth,
  formatCheckLines,
  briefReason,
};
