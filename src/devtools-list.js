/**
 * 读取本机千帆 DevTools 页面列表
 */
const DEVTOOLS_PORT = Number(process.env.QIANFAN_DEVTOOLS_PORT || 9322);
const DEVTOOLS_HOST = process.env.QIANFAN_DEVTOOLS_HOST || '127.0.0.1';

async function fetchDevToolsJsonList(port = DEVTOOLS_PORT, host = DEVTOOLS_HOST) {
  const url = `http://${host}:${port}/json/list`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`DevTools ${host}:${port} 不可用：HTTP ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error(`DevTools ${host}:${port} 返回格式异常`);
  return list;
}

function getPageTargets(list) {
  return list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

module.exports = {
  DEVTOOLS_PORT,
  DEVTOOLS_HOST,
  fetchDevToolsJsonList,
  getPageTargets,
};
