#!/usr/bin/env node
/**
 * 密码 SSH 部署（一次性，勿将密码写入文件）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Client } = require('ssh2');
const { resolveProjectRoot } = require('../src/shared/app-root');

const HOST = process.env.DEPLOY_HOST || '8.137.126.18';
const USER = process.env.DEPLOY_USER || 'root';
const PASSWORD = process.env.DEPLOY_SSH_PASSWORD || '';
const QF_REMOTE = process.env.DEPLOY_QF_REMOTE || '/opt/qianfan-protocol';
const XY_REMOTE = process.env.DEPLOY_XY_REMOTE || '/opt/xiangyu';
const REPO = resolveProjectRoot();
const XY_SRC = path.resolve(REPO, '..', '扫码枪登记出入库系统', 'apps', 'xiangyu');

function connect() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolve(conn))
      .on('error', reject)
      .connect({ host: HOST, port: 22, username: USER, password: PASSWORD, readyTimeout: 60000 });
  });
}

function exec(conn, cmd, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, { pty: false }, (err, stream) => {
      if (err) return reject(err);
      let errOut = '';
      const timer = setTimeout(() => reject(new Error(`timeout: ${cmd.slice(0, 80)}`)), timeoutMs);
      stream
        .on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) reject(new Error(`exit ${code}: ${errOut.slice(0, 2000)}`));
          else resolve();
        })
        .on('data', (d) => process.stdout.write(d));
      stream.stderr.on('data', (d) => {
        errOut += d.toString();
        process.stderr.write(d);
      });
    });
  });
}

function putFile(conn, local, remote) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(local, remote, (e) => {
        sftp.end();
        if (e) reject(e);
        else resolve();
      });
    });
  });
}

function makeTar(localPaths, tarPath, cwd) {
  const args = ['-czf', tarPath, ...localPaths];
  execSync(`tar ${args.map((a) => `"${a}"`).join(' ')}`, { cwd, stdio: 'inherit', shell: true });
}

async function deployQianfan(conn) {
  console.log('\n[deploy] === 千帆协议 + 桥接 ===');
  const tmp = path.join(os.tmpdir(), `qf-deploy-${Date.now()}.tar.gz`);
  makeTar(
    ['src', 'scripts', 'config', 'ecosystem.config.cjs', 'package.json', 'package-lock.json', 'test-assets', 'data'],
    tmp,
    REPO
  );
  console.log('[upload] qianfan tarball ...');
  await putFile(conn, tmp, '/tmp/qianfan-protocol.tar.gz');
  fs.unlinkSync(tmp);

  await exec(
    conn,
    `mkdir -p ${QF_REMOTE} && cd ${QF_REMOTE} && tar xzf /tmp/qianfan-protocol.tar.gz && ` +
      `npm install --omit=dev && ` +
      `pm2 delete qianfan-protocol-daemon qianfan-protocol-bridge 2>/dev/null || true && ` +
      `QIANFAN_PROTOCOL_BRIDGE_PRODUCTION=1 pm2 start ecosystem.config.cjs --only qianfan-protocol-daemon,qianfan-protocol-bridge && ` +
      `pm2 save && sleep 2 && ` +
      `echo "=== daemon ===" && curl -s http://127.0.0.1:9324/api/health && echo && ` +
      `echo "=== bridge ===" && curl -s http://127.0.0.1:35872/health && echo`
  );
}

async function deployXiangyu(conn) {
  if (!fs.existsSync(XY_SRC)) {
    console.warn(`[deploy] 跳过祥钰：未找到 ${XY_SRC}`);
    return;
  }
  console.log('\n[deploy] === 祥钰 Web ===');
  const tmp = path.join(os.tmpdir(), `xy-deploy-${Date.now()}.tar.gz`);
  const items = ['server', 'client', 'scripts', 'package.json'];
  if (fs.existsSync(path.join(XY_SRC, 'package-lock.json'))) items.push('package-lock.json');
  if (fs.existsSync(path.join(XY_SRC, 'config.server.json'))) items.push('config.server.json');
  makeTar(items, tmp, XY_SRC);
  await putFile(conn, tmp, '/tmp/xiangyu.tar.gz');
  fs.unlinkSync(tmp);

  await exec(
    conn,
    `mkdir -p ${XY_REMOTE} && cd ${XY_REMOTE} && tar xzf /tmp/xiangyu.tar.gz && ` +
      `(test -f config.server.json && cp config.server.json config.json || true) && ` +
      `node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('config.json','utf8'));c.bridge=c.bridge||{};c.bridge.url='http://127.0.0.1:35872/send';c.bridge.mode='http';c.server=c.server||{};c.server.host='0.0.0.0';c.server.port=35871;fs.writeFileSync('config.json',JSON.stringify(c,null,2));" && ` +
      `npm install --omit=dev && ` +
      `pm2 delete xiangyu-web 2>/dev/null || true && ` +
      `pm2 start server/index.js --name xiangyu-web && pm2 save && sleep 2 && ` +
      `curl -s -o /dev/null -w "xiangyu HTTP %{http_code}\\n" http://127.0.0.1:35871/`
  );
}

async function openFirewall(conn) {
  console.log('\n[deploy] === 防火墙 ===');
  await exec(
    conn,
    `(command -v firewall-cmd >/dev/null && firewall-cmd --permanent --add-port=35871/tcp --add-port=35872/tcp 2>/dev/null && firewall-cmd --reload) || ` +
      `(command -v ufw >/dev/null && ufw allow 35871/tcp && ufw allow 35872/tcp) || echo skip-firewall`,
    120000
  );
}

async function main() {
  if (!PASSWORD) {
    console.error('[deploy] 请设置 DEPLOY_SSH_PASSWORD');
    process.exit(1);
  }
  console.log(`[deploy] 连接 ${USER}@${HOST} ...`);
  const conn = await connect();
  try {
    await deployQianfan(conn);
    await deployXiangyu(conn);
    await openFirewall(conn);
    console.log('\n[deploy] 完成');
    console.log(`  祥钰: http://${HOST}:35871/`);
    console.log(`  桥接: http://${HOST}:35872/send`);
  } finally {
    conn.end();
  }
}

main().catch((err) => {
  console.error('[deploy] 失败:', err.message || err);
  process.exit(1);
});
