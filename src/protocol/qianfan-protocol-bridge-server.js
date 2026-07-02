/**
 * 千帆纯协议桥接 HTTP 服务（祥钰 bridge-relay 兼容）
 */
const http = require('http');
const { println } = require('../utils');
const {
  handleBridgeHealth,
  handleBridgeOpenSession,
  handleBridgeSend,
} = require('./qianfan-protocol-bridge-handlers');

function readBody(req, maxBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function createProtocolBridgeServer(options = {}) {
  const host = options.host || process.env.QIANFAN_PROTOCOL_BRIDGE_HOST || '0.0.0.0';
  const port = Number(process.env.QIANFAN_PROTOCOL_BRIDGE_PORT || options.port || 35872);
  const defaultShop = String(options.defaultShop || process.env.QIANFAN_PROTOCOL_BRIDGE_SHOP || '祥钰珠宝');

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || '/', `http://${host}:${port}`);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        if (req.method === 'GET' && url.pathname === '/health') {
          const shop = url.searchParams.get('shopTitle') || url.searchParams.get('shop') || defaultShop;
          const result = await handleBridgeHealth(shop);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/open-session') {
          const body = await readBody(req);
          const result = await handleBridgeOpenSession(body);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/send') {
          const body = await readBody(req);
          const result = await handleBridgeSend(body);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not found' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: String(err.message || err) }));
      }
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
      println(`[protocol-bridge] 祥钰桥接 http://${host}:${port} (纯协议)`);
      return { host, port };
    },
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = {
  createProtocolBridgeServer,
};
