/**
 * 千帆 impaas HTTP 鉴权头合并（authorization a1:）
 * 注意：不可同时发送 authorization 与 Authorization，否则 401。
 */
function pickHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const target = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === target) return String(v || '');
  }
  return '';
}

function normalizeImpaasHttpHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lower = String(k).toLowerCase();
    if (['cookie', 'content-length', 'host', 'connection', 'accept-encoding'].includes(lower)) continue;
    if (lower === 'service-tag' && !String(v || '').trim()) continue;
    if (lower === 'authorization') {
      out.authorization = v;
      continue;
    }
    out[k] = v;
  }
  const auth = pickHeader(headers, 'authorization');
  if (auth) out.authorization = auth;
  return out;
}

function mergeHttpAuthHeaders(baseHeaders = {}, templateHeaders = {}, cookie = '', options = {}) {
  const out = { ...normalizeImpaasHttpHeaders(baseHeaders) };
  const tpl = normalizeImpaasHttpHeaders(templateHeaders);
  for (const [k, v] of Object.entries(tpl)) {
    out[k] = v;
  }
  const auth = pickHeader(out, 'authorization') || pickHeader(templateHeaders, 'authorization');
  if (auth) {
    out.authorization = auth;
    delete out.Authorization;
  }
  if (cookie && !pickHeader(out, 'cookie') && options.sendCookie !== false) {
    out.Cookie = cookie;
  }
  return out;
}

function extractAuthFromSnapshot(snapshot) {
  const tpl =
    snapshot?.lastMessageListRequest?.headers ||
    snapshot?.httpTemplates?.['/api/impaas/message/user/list']?.headers ||
    snapshot?.httpTemplates?.messageList?.headers ||
    {};
  return pickHeader(tpl, 'authorization');
}

module.exports = {
  pickHeader,
  normalizeImpaasHttpHeaders,
  mergeHttpAuthHeaders,
  extractAuthFromSnapshot,
};
