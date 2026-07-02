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
  const tmp = path.join(os.tmpdir(), `qf-imtoken-${Date.now()}.tar.gz`);
  tar(
    [
      'src/protocol/qianfan-protocol-eva-upload.js',
      'src/protocol/qianfan-protocol-service.js',
      'config/qianfan-protocol-shops.local.json',
    ],
    tmp,
    REPO
  );
  const conn = await connect();
  try {
    await put(conn, tmp, '/tmp/qf-imtoken.tar.gz');
    fs.unlinkSync(tmp);
    await exec(
      conn,
      'cd /opt/qianfan-protocol && tar xzf /tmp/qf-imtoken.tar.gz && pm2 restart qianfan-protocol-bridge && sleep 2 && ' +
        'node -e "const {resolveImToken,fetchPermit}=require(\'./src/protocol/qianfan-protocol-eva-upload\');const {findProtocolShopConfig}=require(\'./src/protocol/qianfan-protocol-config\');(async()=>{const c=findProtocolShopConfig(\'祥钰珠宝\');const t=await resolveImToken(c);console.log(\'im_token:\',t||\'(empty)\');try{const p=await fetchPermit(c);console.log(\'permit ok\',p.fileIds?.[0]);}catch(e){console.log(\'permit err\',e.message);}})();"'
    );
    console.log('\n[deploy] im_token 修复已部署');
  } finally {
    conn.end();
  }
}

main().catch((e) => {
  console.error('[deploy]', e.message);
  process.exit(1);
});
