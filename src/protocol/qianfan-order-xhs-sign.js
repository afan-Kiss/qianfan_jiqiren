/**
 * 千帆订单 API 动态签名（xhshow Python，与换票采集同源）
 */
const { spawnSync } = require('child_process');
const { resolveXhsSignerPaths } = require('../analyst-app-path');

function extractAtToken(cookie) {
  const text = String(cookie || '');
  const patterns = [
    /access-token-walle\.xiaohongshu\.com=customer\.eva\.(AT-[A-Za-z0-9]+)/i,
    /walle-eva-auth=[^!]*!!(AT-[A-Za-z0-9]+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return '';
}

function signOrderApiHeaders(method, url, cookie, options = {}) {
  const { python, signerScript } = resolveXhsSignerPaths(options);
  const input = JSON.stringify({
    method: method || 'GET',
    url,
    cookie: String(cookie || ''),
    xsec_appid: options.xsecAppid || 'walle',
    body: options.body,
  });
  const r = spawnSync(python, [signerScript], { input, encoding: 'utf8' });
  if (r.error) throw r.error;
  let parsed;
  try {
    parsed = JSON.parse(r.stdout || '{}');
  } catch {
    throw new Error(`签名脚本输出异常: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
  }
  if (!parsed.ok || !parsed.headers) {
    throw new Error(parsed.message || 'xhshow 签名失败');
  }
  return parsed.headers;
}

function buildSignedOrderFetchHeaders(shopConfig, url, options = {}) {
  const cookie = String(shopConfig?.cookie || '');
  const signed = signOrderApiHeaders(options.method || 'GET', url, cookie, options);
  const at = extractAtToken(cookie) || signed.authorization;
  const headers = {
    Accept: 'application/json, text/plain, */*',
    Cookie: cookie,
    Authorization: at.startsWith('AT-') ? at : `AT-${at}`,
    'User-Agent':
      shopConfig.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) eva/1.2.6 Chrome/128.0.6613.186 Electron/32.2.8 Safari/537.36',
    Referer: options.referer || 'https://walle.xiaohongshu.com/cstools/tools/packages',
    'x-subsystem': 'eva',
    'x-s': signed['x-s'],
    'x-t': signed['x-t'],
    'x-s-common': signed['x-s-common'],
  };
  return headers;
}

module.exports = {
  signOrderApiHeaders,
  buildSignedOrderFetchHeaders,
};
