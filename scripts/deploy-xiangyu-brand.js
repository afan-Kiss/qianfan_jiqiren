const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Client } = require('ssh2');

const PASSWORD = process.env.DEPLOY_SSH_PASSWORD || '';
const XY = path.resolve(__dirname, '..', '..', '扫码枪登记出入库系统', 'apps', 'xiangyu');

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
  const tmp = path.join(os.tmpdir(), `xy-brand-${Date.now()}.tar.gz`);
  tar(['client', 'config.server.json'], tmp, XY);
  const conn = await connect();
  try {
    await put(conn, tmp, '/tmp/xy-brand.tar.gz');
    fs.unlinkSync(tmp);
    await exec(
      conn,
      `cd /opt/xiangyu && tar xzf /tmp/xy-brand.tar.gz && ` +
        `node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('config.server.json','utf8'));const cur=JSON.parse(fs.readFileSync('config.json','utf8'));cur.shop=cur.shop||{};cur.shop.name=c.shop.name;fs.writeFileSync('config.json',JSON.stringify(cur,null,2));" && ` +
        `pm2 restart xiangyu-web && sleep 2 && ` +
        `curl -sk https://127.0.0.1/xiangyuxitong/ -H 'Host: 8.137.126.18' | head -c 280 && echo`
    );
    console.log('\n[deploy] 品牌与图标已更新');
  } finally {
    conn.end();
  }
}

main().catch((e) => {
  console.error('[deploy]', e.message);
  process.exit(1);
});
