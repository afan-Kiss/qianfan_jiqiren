/**
 * 千帆订单采集 — 本地静态页面服务（拉单 API 走服务器 protocol-bridge）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { resolveProjectRoot } = require('../shared/app-root');
const { println } = require('../utils');

const CLIENT_DIR = path.join(resolveProjectRoot(), 'client', 'qianfan-order-collector');

function defaultOrderApiBase() {
  return (
    String(process.env.QIANFAN_ORDER_API_BASE || '').trim() ||
    'http://127.0.0.1:35872'
  );
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

function serveStatic(res, relPath) {
  const filePath = path.join(CLIENT_DIR, relPath);
  if (!filePath.startsWith(CLIENT_DIR) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }
  res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
  fs.createReadStream(filePath).pipe(res);
}

function createOrderCollectorServer(options = {}) {
  const host = options.host || process.env.QIANFAN_ORDER_COLLECTOR_HOST || '127.0.0.1';
  const port = Number(process.env.QIANFAN_ORDER_COLLECTOR_PORT || options.port || 9325);
  const orderApiBase = String(options.orderApiBase || defaultOrderApiBase()).replace(/\/$/, '');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathOnly = url.pathname;

    if (req.method === 'GET' && pathOnly === '/api/config') {
      sendJson(res, 200, {
        ok: true,
        service: 'qianfan-order-collector-ui',
        orderApiBase,
        hint: '拉单请求发往服务器 protocol-bridge，本机仅提供采集页面',
      });
      return;
    }

    if (req.method === 'GET' && pathOnly === '/api/health') {
      sendJson(res, 200, { ok: true, service: 'qianfan-order-collector-ui', orderApiBase });
      return;
    }

    if (req.method === 'GET' && (pathOnly === '/' || pathOnly === '/index.html')) {
      serveStatic(res, 'index.html');
      return;
    }
    if (req.method === 'GET' && pathOnly === '/app.js') {
      serveStatic(res, 'app.js');
      return;
    }
    if (req.method === 'GET' && pathOnly === '/style.css') {
      serveStatic(res, 'style.css');
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  });

  return {
    server,
    host,
    port,
    orderApiBase,
    start() {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          println(`[订单采集UI] http://${host}:${port}/  → 拉单API ${orderApiBase}`);
          resolve({ host, port, orderApiBase });
        });
      });
    },
  };
}

module.exports = { createOrderCollectorServer, CLIENT_DIR, defaultOrderApiBase };
