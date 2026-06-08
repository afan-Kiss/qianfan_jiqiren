/**
 * wxbot-new 回调服务（第一阶段：仅日志 + 控制台，不 dispatchReply）
 */
const http = require('http');
const net = require('net');
const { execSync } = require('child_process');
const config = require('./wechat/wxbot-new-config');
const { appendCallbackLog, formatCallbackConsoleLine } = require('./wxbot-new-callback-log');
const { println } = require('./utils');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isPortInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(true));
    tester.once('listening', () => tester.close(() => resolve(false)));
    tester.listen(port, host);
  });
}

function killListenersOnPort(port) {
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = new Set();
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid) && pid !== String(process.pid)) {
        pids.add(pid);
      }
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      } catch {
        // ignore
      }
    }
    return pids.size > 0;
  } catch {
    return false;
  }
}

function matchCallbackPath(url) {
  const callbackPath = config.callbackPath || '/wechat/wxbot-new/callback';
  const raw = String(url || '').split('?')[0];
  if (raw === callbackPath) return true;
  if (raw.endsWith(callbackPath)) return true;
  if (raw.replace(/\/+$/, '') === callbackPath.replace(/\/+$/, '')) return true;
  return false;
}

/**
 * @param {{ onCallback?: (line: string, parsed: object) => void, silent?: boolean, forcePort?: boolean }} [options]
 */
async function startWxbotCallbackServer(options = {}) {
  const port = config.callbackPort || 8787;
  let busy = await isPortInUse(port);

  if (busy && options.forcePort) {
    if (!options.silent) {
      println(`[回调] ${port} 端口已占用，正在释放旧进程...`);
    }
    killListenersOnPort(port);
    await new Promise((r) => setTimeout(r, 500));
    busy = await isPortInUse(port);
  }

  if (busy) {
    if (!options.silent) {
      println(`[回调] ${port} 端口已占用，可能回调服务已启动`);
    }
    return { server: null, port, alreadyRunning: true };
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== 'POST' || !matchCallbackPath(req.url)) {
          res.writeHead(404);
          res.end('not found');
          return;
        }

        const bodyText = await readBody(req);
        let body = {};
        try {
          body = bodyText ? JSON.parse(bodyText) : {};
        } catch {
          body = { raw: bodyText };
        }

        // 先快速响应 wxbot，避免千帆 CDP 监听占用事件循环导致回调超时
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));

        setImmediate(() => {
          void (async () => {
            try {
              const parsed = appendCallbackLog(body);
              const line = formatCallbackConsoleLine(parsed);
              if (typeof options.onCallback === 'function') {
                await Promise.resolve(options.onCallback(line, parsed, body));
              } else if (!options.silent) {
                println(line);
              }
            } catch (err) {
              if (!options.silent) {
                println(`[回调] 记录失败：${err.message || err}`);
              }
            }
          })();
        });
      } catch (err) {
        if (!options.silent) {
          println(`[回调] 处理失败：${err.message || err}`);
        }
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('error');
        }
      }
    })();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  if (!options.silent) {
    println(`[回调] 已启动 ${config.callbackUrl}`);
  }

  return { server, port, alreadyRunning: false };
}

async function main() {
  println('');
  println('======== 微信回调服务（仅日志） ========');
  println(`监听：${config.callbackUrl}`);
  println('说明：本服务只记录回调，不触发千帆发送');
  println('');

  await startWxbotCallbackServer({
    onCallback: (line) => println(line),
    forcePort: true,
  });
}

if (require.main === module) {
  main().catch((err) => {
    println(`[回调] 启动异常：${err.message || err}`);
    process.exit(1);
  });
}

module.exports = {
  startWxbotCallbackServer,
  killListenersOnPort,
};
