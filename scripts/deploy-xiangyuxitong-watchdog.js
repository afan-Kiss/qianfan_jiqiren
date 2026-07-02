#!/usr/bin/env node
/** 部署祥钰保活 watchdog + 独立 nginx snippet + cron */
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const PASSWORD = process.env.DEPLOY_SSH_PASSWORD || '';
const REPO = path.resolve(__dirname, '..');

function connect() {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => resolve(c)).on('error', reject).connect({
      host: '8.137.126.18',
      username: 'root',
      password: PASSWORD,
      readyTimeout: 60000,
    });
  });
}

function put(conn, local, remote) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(local, remote, (e) => {
        sftp.end();
        e ? reject(e) : resolve();
      });
    });
  });
}

function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let errOut = '';
      stream.on('data', (d) => process.stdout.write(d));
      stream.stderr.on('data', (d) => {
        errOut += d.toString();
        process.stderr.write(d);
      });
      stream.on('close', (code) => (code ? reject(new Error(errOut || `exit ${code}`)) : resolve()));
    });
  });
}

async function main() {
  if (!PASSWORD) throw new Error('DEPLOY_SSH_PASSWORD required');
  const conn = await connect();
  const files = [
    ['scripts/xiangyuxitong-watchdog.js', '/opt/qianfan-protocol/scripts/xiangyuxitong-watchdog.js'],
    ['scripts/nginx-xiangyuxitong-locations.conf', '/opt/qianfan-protocol/scripts/nginx-xiangyuxitong-locations.conf'],
  ];
  try {
    for (const [rel, remote] of files) {
      await put(conn, path.join(REPO, rel), remote);
      console.log(`[deploy] uploaded ${path.basename(remote)}`);
    }
    await exec(
      conn,
      `chmod +x /opt/qianfan-protocol/scripts/xiangyuxitong-watchdog.js && ` +
        `mkdir -p /etc/aa_nginx/snippets && ` +
        `node /opt/qianfan-protocol/scripts/xiangyuxitong-watchdog.js && ` +
        `(crontab -l 2>/dev/null | grep -v xiangyuxitong-watchdog; ` +
        `echo '*/5 * * * * cd /opt/qianfan-protocol && /usr/bin/node scripts/xiangyuxitong-watchdog.js >/dev/null 2>&1') | crontab - && ` +
        `echo "=== cron ===" && crontab -l | grep xiangyuxitong && ` +
        `echo "=== probe ===" && curl -sk -o /dev/null -w "page:%{http_code}\\n" https://127.0.0.1/xiangyuxitong/ -H "Host: 8.137.126.18" && ` +
        `curl -sk https://127.0.0.1/xiangyuxitong-bridge/health -H "Host: 8.137.126.18" | head -c 120 && echo`
    );
    console.log('\n[deploy] 祥钰保活已启用（每 5 分钟自检）');
  } finally {
    conn.end();
  }
}

main().catch((e) => {
  console.error('[deploy]', e.message);
  process.exit(1);
});
