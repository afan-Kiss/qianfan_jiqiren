const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
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

function tar(items, out, cwd) {
  execSync(`tar -czf "${out}" ${items.map((i) => `"${i}"`).join(' ')}`, { cwd, stdio: 'inherit', shell: true });
}

async function main() {
  if (!PASSWORD) throw new Error('DEPLOY_SSH_PASSWORD required');
  const tmp = path.join(os.tmpdir(), `qf-send-guard-${Date.now()}.tar.gz`);
  tar(
    [
      'src/qianfan-send-guard.js',
      'src/qianfan-local-api.js',
      'src/wechat/wxbot-new-config.js',
      'src/protocol/qianfan-protocol-send-guard.js',
      'src/protocol/qianfan-protocol-service.js',
      'ecosystem.config.cjs',
    ],
    tmp,
    REPO
  );
  const conn = await connect();
  try {
    await put(conn, tmp, '/tmp/qf-send-guard.tar.gz');
    fs.unlinkSync(tmp);
    await exec(
      conn,
      'cd /opt/qianfan-protocol && tar xzf /tmp/qf-send-guard.tar.gz && ' +
        'pm2 delete qianfan-protocol-bridge 2>/dev/null || true && ' +
        'pm2 start ecosystem.config.cjs --only qianfan-protocol-bridge --update-env && ' +
        'sleep 2 && curl -sk https://127.0.0.1/xiangyuxitong-bridge/health -H "Host: 8.137.126.18"'
    );
    console.log('\n[deploy] 发送白名单已关闭，可向任意买家发送');
  } finally {
    conn.end();
  }
}

main().catch((e) => {
  console.error('[deploy]', e.message);
  process.exit(1);
});
