#!/usr/bin/env node
/** 部署 Cookie 从主播分析系统读取的改动 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Client } = require('ssh2');

const PASSWORD = process.env.DEPLOY_SSH_PASSWORD || '';
const QF = path.resolve(__dirname, '..');
const XY = path.resolve(QF, '..', '扫码枪登记出入库系统', 'apps', 'xiangyu');
const ANALYST = path.resolve(QF, '..', '主播分析软件');

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

async function deployAnalyst(conn) {
  console.log('\n[deploy] 主播分析系统 API /plain');
  const files = [
    'apps/server/src/routes/shop-cookies.routes.ts',
    'apps/server/src/services/official-shop-account.service.ts',
  ];
  for (const rel of files) {
    const local = path.join(ANALYST, rel);
    const remote = `/www/wwwroot/zhubo-analysis/${rel.replace(/\\/g, '/')}`;
    await put(conn, local, remote);
    console.log(`  uploaded ${path.basename(local)}`);
  }
  await exec(conn, 'cd /www/wwwroot/zhubo-analysis/apps/server && npm run build 2>&1 | tail -5');
  await exec(conn, 'pm2 restart zhubo-analysis && sleep 3 && curl -s "http://127.0.0.1:4723/api/shop-cookies/plain?shopKey=xiangyu" | head -c 120 && echo');
}

async function deployXiangyu(conn) {
  console.log('\n[deploy] 祥钰 Cookie 兜底');
  const tmp = path.join(os.tmpdir(), `xy-cookie-${Date.now()}.tar.gz`);
  tar(['server', 'config.server.json'], tmp, XY);
  await put(conn, tmp, '/tmp/xiangyu-cookie.tar.gz');
  fs.unlinkSync(tmp);
  await exec(
    conn,
    `cd /opt/xiangyu && tar xzf /tmp/xiangyu-cookie.tar.gz && cp config.server.json config.json && ` +
      `node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('config.json','utf8'));c.orders=c.orders||{};c.orders.analystCookieEnabled=true;c.orders.analystCookieBaseUrl='http://127.0.0.1:4723';fs.writeFileSync('config.json',JSON.stringify(c,null,2));" && ` +
      `pm2 restart xiangyu-web`
  );
}

async function deployProtocol(conn) {
  console.log('\n[deploy] 协议桥接 Cookie 兜底');
  const tmp = path.join(os.tmpdir(), `qf-cookie-${Date.now()}.tar.gz`);
  tar(['src/protocol/qianfan-protocol-analyst-cookie.js', 'src/protocol/qianfan-protocol-bridge-handlers.js'], tmp, QF);
  await put(conn, tmp, '/tmp/qf-cookie.tar.gz');
  fs.unlinkSync(tmp);
  await exec(conn, 'cd /opt/qianfan-protocol && tar xzf /tmp/qf-cookie.tar.gz && pm2 restart qianfan-protocol-bridge');
}

async function main() {
  if (!PASSWORD) throw new Error('DEPLOY_SSH_PASSWORD required');
  const conn = await connect();
  try {
    await deployAnalyst(conn);
    await deployXiangyu(conn);
    await deployProtocol(conn);
    console.log('\n[deploy] Cookie 兜底链路已部署');
  } finally {
    conn.end();
  }
}

main().catch((e) => {
  console.error('[deploy]', e.message);
  process.exit(1);
});
