/**
 * wxbot-new HTTP 辅助（同步 callback 配置等）
 */
const config = require('./wechat/wxbot-new-config');
const { fetchWithTimeout } = require('./fetch-timeout');

function authHeaders(extra = {}) {
  const headers = { Accept: 'application/json', ...extra };
  if (config.username && config.password) {
    headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  }
  return headers;
}

async function putConfigItem(key, value) {
  const url = `${config.baseUrl.replace(/\/$/, '')}/api/config/${encodeURIComponent(key)}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ value }),
    },
    8000
  );
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok || body?.code !== 0) {
    throw new Error(body?.message || text || `HTTP ${res.status}`);
  }
  return body;
}

async function syncWxbotCallbackConfig() {
  const callbackUrl = config.callbackUrl || 'http://127.0.0.1:8787/wechat/wxbot-new/callback';
  await putConfigItem('callback_urls', [callbackUrl]);
  await putConfigItem('log_recv_callback', 1);
}

module.exports = {
  syncWxbotCallbackConfig,
  putConfigItem,
};
