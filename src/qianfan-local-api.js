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

      if (req.method === 'GET' && pathOnly === '/api/qianfan/protocol/tap/status') {
        try {
          const { getProtocolTapStatus } = require('./capture/qianfan-protocol-tap');
          sendJson(res, 200, { ok: true, ...getProtocolTapStatus() });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err.message || 'tap status failed' });
        }
        return;
      }

      if (req.method === 'POST' && pathOnly === '/api/qianfan/protocol/tap/bundle') {
        try {
          const raw = await readBody(req).catch(() => '');
          let sinceMs = 10 * 60 * 1000;
          if (raw) {
            try {
              const body = JSON.parse(raw);
              if (body.sinceMs) sinceMs = Number(body.sinceMs);
            } catch {
              // ignore
            }
          }
          const { bundleProtocolTap } = require('./capture/qianfan-protocol-tap');
          const result = bundleProtocolTap({ sinceMs });
          sendJson(res, result.ok ? 200 : 404, result);
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err.message || 'tap bundle failed' });
        }
        return;
      }

      if (req.method === 'GET' && pathOnly === '/api/qianfan/protocol/snapshot') {
        try {
          const urlObj = new URL(req.url, 'http://127.0.0.1');
          const shopTitle = String(urlObj.searchParams.get('shopTitle') || '').trim();
          const refresh = String(urlObj.searchParams.get('refresh') || '1') !== '0';
          if (!shopTitle) {
            sendJson(res, 400, { ok: false, error: 'missing shopTitle' });
            return;
          }
          const { enrichAndBuildQianfanProtocolSnapshot, buildQianfanProtocolSnapshot } = require('./qianfan-ws-bridge');
          const { summarizeCookie } = require('./protocol/qianfan-protocol-config');
          const snapshot = refresh
            ? await enrichAndBuildQianfanProtocolSnapshot(shopTitle, { cookieWaitMs: 2500 })
            : buildQianfanProtocolSnapshot(shopTitle);
          if (!snapshot.ok) {
            sendJson(res, 404, { ok: false, error: snapshot.error || 'bridge_not_found', snapshot });
            return;
          }
          const cookie = String(snapshot.cookieSources?.mergedNetworkHeaderCookie || '');
          sendJson(res, 200, {
            ok: true,
            snapshot,
            cookieSummary: summarizeCookie(cookie),
            refreshed: refresh,
          });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err.message || 'snapshot failed' });
        }
        return;
      }

      if (pathOnly.startsWith('/api/qianfan/protocol/im/')) {
        try {
          const { getProtocolImService } = require('./protocol/qianfan-protocol-service');
          const urlObj = new URL(req.url, 'http://127.0.0.1');
          const shopTitle = String(urlObj.searchParams.get('shopTitle') || '').trim();
          if (!shopTitle) {
            sendJson(res, 400, { ok: false, error: 'missing shopTitle' });
            return;
          }

          if (req.method === 'GET' && pathOnly === '/api/qianfan/protocol/im/status') {
            const svc = await getProtocolImService(shopTitle, { noCache: true });
            sendJson(res, 200, { ok: true, pureOnly: true, ...svc.getStatus() });
            return;
          }

          if (req.method === 'GET' && pathOnly === '/api/qianfan/protocol/im/sessions') {
            const svc = await getProtocolImService(shopTitle);
            sendJson(res, 200, { ok: true, sessions: svc.listSessions() });
            return;
          }

          if (req.method === 'GET' && pathOnly === '/api/qianfan/protocol/im/history') {
            const appCid = String(urlObj.searchParams.get('appCid') || '').trim();
            const buyerNick = String(urlObj.searchParams.get('buyerNick') || '').trim();
            const allPages = String(urlObj.searchParams.get('allPages') || '1') !== '0';
            const svc = await getProtocolImService(shopTitle);
            const result = await svc.pullSessionHistory(appCid, { buyerNick, allPages });
            sendJson(res, result.ok ? 200 : 502, { ok: result.ok, ...result });
            return;
          }

          if (req.method === 'GET' && pathOnly === '/api/qianfan/protocol/im/history/all') {
            const includeMessages = String(urlObj.searchParams.get('includeMessages') || '0') === '1';
            const maxPages = Number(urlObj.searchParams.get('maxPages') || 10);
            const svc = await getProtocolImService(shopTitle);
            const result = await svc.pullAllSessionsMessages({
              includeMessages,
              maxPagesPerSession: maxPages,
              concurrency: 2,
              delayMs: 120,
            });
            sendJson(res, result.ok ? 200 : 502, { ok: result.ok, ...result });
            return;
          }

          if (req.method === 'POST' && pathOnly === '/api/qianfan/protocol/im/send-text') {
            const raw = await readBody(req).catch(() => '');
            let body = {};
            try {
              body = raw ? JSON.parse(raw) : {};
            } catch {
              sendJson(res, 400, { ok: false, error: 'invalid json body' });
              return;
            }
            const { isProtocolImSendAllowed } = require('./protocol/qianfan-protocol-send-guard');
            const buyerNick = String(body.buyerNick || '饭饭').trim();
            if (body.reallySend && !isProtocolImSendAllowed(buyerNick)) {
              sendJson(res, 403, {
                ok: false,
                error: `纯协议 IM 仅允许向「饭饭」发送，当前 buyerNick=${buyerNick || '(空)'}`,
              });
              return;
            }
            const svc = await getProtocolImService(shopTitle);
            try {
              const result = await svc.sendText({
                appCid: body.appCid,
                receiverAppUids: body.receiverAppUids,
                text: body.text,
                buyerNick,
                reallySend: Boolean(body.reallySend),
                verifyList: body.verifyList !== false,
              });
              sendJson(res, result.ok ? 200 : 502, { ok: result.ok, ...result });
            } catch (err) {
              sendJson(res, 403, { ok: false, error: err.message || 'send blocked' });
            }
            return;
          }

          sendJson(res, 404, { ok: false, error: 'unknown protocol im route' });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err.message || 'protocol im failed' });
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
