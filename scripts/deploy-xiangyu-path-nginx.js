const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Client } = require('ssh2');

const PASSWORD = process.env.DEPLOY_SSH_PASSWORD || '';
const REPO = path.resolve(__dirname, '..');
const XY_SRC = path.resolve(REPO, '..', '扫码枪登记出入库系统', 'apps', 'xiangyu');

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
  const conn = await connect();

  await put(conn, path.join(__dirname, '_nginx-xiangyu.conf'), '/www/server/panel/vhost/nginx/xiangyu-web.conf');
  console.log('[deploy] nginx 配置已上传');

  const tmp = path.join(os.tmpdir(), `xy-path-${Date.now()}.tar.gz`);
  const items = ['server', 'client', 'scripts', 'package.json', 'config.server.json'];
  if (fs.existsSync(path.join(XY_SRC, 'package-lock.json'))) items.push('package-lock.json');
  tar(items, tmp, XY_SRC);
  await put(conn, tmp, '/tmp/xiangyu.tar.gz');
  fs.unlinkSync(tmp);

  await exec(
    conn,
    `cd /opt/xiangyu && tar xzf /tmp/xiangyu.tar.gz && cp config.server.json config.json && ` +
      `node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('config.json','utf8'));c.auth={passwordHash:''};c.bridge.url='http://127.0.0.1:35872/send';fs.writeFileSync('config.json',JSON.stringify(c,null,2));" && ` +
      `npm install --omit=dev && pm2 restart xiangyu-web && ` +
      `aa_nginx -t && aa_nginx -s reload && sleep 2 && ` +
      `echo "=== xiangyu ===" && curl -s -o /dev/null -w "proxy:%{http_code}\\n" http://127.0.0.1/xiangyu-proxy/ -H "Host: 8.137.126.18" && ` +
      `echo "=== bridge ===" && curl -s http://127.0.0.1/xiangyu-bridge/health -H "Host: 8.137.126.18" && echo`
  );
  conn.end();
  console.log('\n[deploy] 完成');
  console.log('  祥钰: http://8.137.126.18/xiangyu-proxy/');
  console.log('  桥接: http://8.137.126.18/xiangyu-bridge/health');
}

main().catch((e) => {
  console.error('[deploy]', e.message);
  process.exit(1);
});
