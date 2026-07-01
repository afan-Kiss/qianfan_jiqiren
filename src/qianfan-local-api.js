/**
 * 千帆中转机器人本地 HTTP API（供本地总控 EXE 触发 Cookie 同步）
 */
const http = require('http');
const net = require('net');
const config = require('./wechat/wxbot-new-config');
const { println } = require('./utils');
const { runSyncNowAll, getAutoSyncStatus } = require('./qianfan-cookie-collector');
const { runShopCookieUploadAll, getShopCookieUploadConfig } = require('./shop-cookie-uploader');

const DEFAULT_PORT = 9323;

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

function isPortInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(true));
    tester.once('listening', () => tester.close(() => resolve(false)));
    tester.listen(port, host);
  });
}

function getLocalApiPort() {
  const cc = config.controlCenter || {};
  return Number(process.env.QIANFAN_LOCAL_API_PORT || cc.localApiPort || DEFAULT_PORT);
}

/**
 * @param {{ silent?: boolean }} [options]
 */
async function startQianfanLocalApi(options = {}) {
  const port = getLocalApiPort();
  const busy = await isPortInUse(port);
  if (busy) {
    if (!options.silent) {
      println(`[本地API] ${port} 端口已占用，可能本地 API 已启动`);
    }
    return { server: null, port, alreadyRunning: true };
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const pathOnly = String(req.url || '').split('?')[0];

      if (req.method === 'GET' && pathOnly === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          service: 'qianfan-relay',
          source: 'qianfan-bridge',
        });
        return;
      }

      if (req.method === 'GET' && pathOnly === '/api/cookie/status') {
        sendJson(res, 200, getAutoSyncStatus());
        return;
      }

      if (req.method === 'POST' && pathOnly === '/api/cookie/sync-now') {
        await readBody(req).catch(() => '');
        try {
          const result = await runSyncNowAll('exe_trigger');
          sendJson(res, result.ok ? 200 : 503, result);
        } catch (err) {
          sendJson(res, 500, {
            ok: false,
            message: err.message || 'Cookie 同步失败',
            shops: [],
          });
        }
        return;
      }

      if (req.method === 'POST' && pathOnly === '/api/shop-cookies/upload') {
        await readBody(req).catch(() => '');
        try {
          const result = await runShopCookieUploadAll('local_api', {
            force: true,
            verifyStatus: true,
          });
          sendJson(res, result.ok ? 200 : 503, result);
        } catch (err) {
          sendJson(res, 500, {
            ok: false,
            message: err.message || '四店 Cookie 提交失败',
            shops: [],
          });
        }
        return;
      }

      if (req.method === 'GET' && pathOnly === '/api/shop-cookies/status') {
        try {
          const { fetchShopCookieStatus } = require('./shop-cookie-uploader');
          const result = await fetchShopCookieStatus();
          sendJson(res, result.ok ? 200 : result.httpStatus || 503, {
            ok: result.ok,
            data: result.data,
            httpStatus: result.httpStatus,
          });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err.message || 'status failed' });
        }
        return;
      }

      if (req.method === 'GET' && pathOnly === '/api/qianfan/protocol/live-shops') {
        try {
          const {
            getAllQianfanBridges,
            buildQianfanProtocolSnapshot,
          } = require('./qianfan-ws-bridge');
          const { summarizeLiveShopRow } = require('./protocol/qianfan-live-context-extractor');
          const shops = getAllQianfanBridges().map((bridge) =>
            summarizeLiveShopRow(buildQianfanProtocolSnapshot(bridge.shopTitle))
          );
          sendJson(res, 200, { ok: true, shops });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err.message || 'live-shops failed' });
        }
        return;
      }

      if (req.method === 'GET' && pathOnly === '/api/qianfan/protocol/snapshot') {
        try {
          const urlObj = new URL(req.url, 'http://127.0.0.1');
          const shopTitle = String(urlObj.searchParams.get('shopTitle') || '').trim();
          if (!shopTitle) {
            sendJson(res, 400, { ok: false, error: 'missing shopTitle' });
            return;
          }
          const { buildQianfanProtocolSnapshot } = require('./qianfan-ws-bridge');
          const { summarizeCookie } = require('./protocol/qianfan-protocol-config');
          const snapshot = buildQianfanProtocolSnapshot(shopTitle);
          if (!snapshot.ok) {
            sendJson(res, 404, { ok: false, error: snapshot.error || 'bridge_not_found', snapshot });
            return;
          }
          const cookie = String(snapshot.cookieSources?.mergedNetworkHeaderCookie || '');
          sendJson(res, 200, {
            ok: true,
            snapshot,
            cookieSummary: summarizeCookie(cookie),
          });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err.message || 'snapshot failed' });
        }
        return;
      }

      sendJson(res, 404, { ok: false, message: 'not found' });
    })();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  if (!options.silent) {
    println(`[本地API] 已启动 http://127.0.0.1:${port}`);
  }

  return { server, port, alreadyRunning: false };
}

module.exports = {
  startQianfanLocalApi,
  getLocalApiPort,
  DEFAULT_PORT,
};
