/**
 * 千帆纯协议守护 — HTTP API（status / reload / config upload）
 */
const http = require('http');
const { println } = require('../utils');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function getUploadToken() {
  return String(process.env.QIANFAN_PROTOCOL_CONFIG_UPLOAD_TOKEN || '').trim();
}

function isAuthorized(req) {
  const expected = getUploadToken();
  if (!expected) return true;
  const header = String(req.headers['x-protocol-token'] || req.headers.authorization || '').trim();
  if (header === expected) return true;
  if (header.startsWith('Bearer ') && header.slice(7) === expected) return true;
  return false;
}

function createDaemonApiServer(daemon, options = {}) {
  const host = options.host || process.env.QIANFAN_PROTOCOL_DAEMON_HOST || '0.0.0.0';
  const port = Number(process.env.QIANFAN_PROTOCOL_DAEMON_PORT || options.port || 9324);

  const server = http.createServer((req, res) => {
    void (async () => {
      const pathOnly = String(req.url || '').split('?')[0];

      if (req.method === 'GET' && pathOnly === '/api/health') {
        sendJson(res, 200, { ok: true, service: 'qianfan-protocol-daemon' });
        return;
      }

      if (req.method === 'GET' && pathOnly === '/api/qianfan/protocol/status') {
        sendJson(res, 200, daemon.getStatus());
        return;
      }

      if (req.method === 'POST' && pathOnly === '/api/qianfan/protocol/reload') {
        await readBody(req).catch(() => '');
        try {
          const result = await daemon.reloadConfig('api');
          sendJson(res, 200, { ok: true, ...result, status: daemon.getStatus() });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err.message || String(err) });
        }
        return;
      }

      if (req.method === 'POST' && pathOnly === '/api/qianfan/protocol/config/upload') {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        try {
          const raw = await readBody(req);
          const body = raw ? JSON.parse(raw) : null;
          const shops = Array.isArray(body) ? body : body?.shops;
          if (!Array.isArray(shops)) {
            sendJson(res, 400, { ok: false, error: 'body must be JSON array or { shops: [] }' });
            return;
          }
          const reload = await daemon.saveConfigFromUpload(shops);
          sendJson(res, 200, { ok: true, uploaded: shops.length, reload, status: daemon.getStatus() });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err.message || String(err) });
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not_found' });
    })();
  });

  return {
    server,
    host,
    port,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      println(`[protocol-daemon] API http://${host}:${port}`);
      return { host, port };
    },
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = {
  createDaemonApiServer,
};
