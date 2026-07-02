const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Client } = require('ssh2');

const PASSWORD = process.env.DEPLOY_SSH_PASSWORD || '';
const CONF = '/etc/aa_nginx/conf.d/zhubo-analysis.conf';
const MARKER = '# xiangyuxitong';
const REPO = path.resolve(__dirname, '..');
const XY_SRC = path.resolve(REPO, '..', '扫码枪登记出入库系统', 'apps', 'xiangyu');
const snippet = fs.readFileSync(path.join(__dirname, '_nginx-xiangyu-locations.snippet'), 'utf8').trimEnd() + '\n';

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

function putContent(conn, remote, content) {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  return exec(conn, `echo '${b64}' | base64 -d > ${remote}`);
}

function tar(items, out, cwd) {
  execSync(`tar -czf "${out}" ${items.map((i) => `"${i}"`).join(' ')}`, { cwd, stdio: 'inherit', shell: true });
}

function stripOldXiangyuBlocks(conf) {
  const patterns = [
    /[ \t]*# xiangyu[^\n]*\n[\s\S]*?location = \/xiangyu-bridge \{\n[\s\S]*?\}\n\n?/g,
    /[ \t]*# xiangyuxitong[^\n]*\n[\s\S]*?location = \/xiangyuxitong-bridge \{\n[\s\S]*?\}\n\n?/g,
    /[ \t]*location \/xiangyu-proxy\/ \{[\s\S]*?\}\n\n?/g,
    /[ \t]*location = \/xiangyu-proxy \{[\s\S]*?\}\n\n?/g,
    /[ \t]*location \/xiangyu-bridge\/ \{[\s\S]*?\}\n\n?/g,
    /[ \t]*location = \/xiangyu-bridge \{[\s\S]*?\}\n\n?/g,
    /[ \t]*location \/xiangyuxitong\/ \{[\s\S]*?\}\n\n?/g,
    /[ \t]*location = \/xiangyuxitong \{[\s\S]*?\}\n\n?/g,
    /[ \t]*location \/xiangyuxitong-bridge\/ \{[\s\S]*?\}\n\n?/g,
    /[ \t]*location = \/xiangyuxitong-bridge \{[\s\S]*?\}\n\n?/g,
  ];
  let next = conf;
  for (const re of patterns) next = next.replace(re, '');
  return next;
}

function injectXiangyuLocations(conf) {
  const cleaned = stripOldXiangyuBlocks(conf);
  if (cleaned.includes(MARKER)) return cleaned;
  const anchor = '    location / {';
  const idx = cleaned.lastIndexOf(anchor);
  if (idx < 0) throw new Error('未找到 location / 锚点');
  return cleaned.slice(0, idx) + snippet + '\n' + cleaned.slice(idx);
}

async function patchNginx(conn) {
  let conf = '';
  await new Promise((resolve, reject) => {
    conn.exec(`cat ${CONF}`, (err, stream) => {
      if (err) return reject(err);
      stream.on('data', (d) => {
        conf += d.toString();
      });
      stream.on('close', resolve);
    });
  });
  const next = injectXiangyuLocations(conf);
  if (next === conf) {
    console.log('[nginx] 祥钰路径已是最新');
    return;
  }
  await exec(conn, `cp ${CONF} ${CONF}.bak-xiangyuxitong`);
  await putContent(conn, CONF, next);
  console.log('[nginx] 已注入 /xiangyuxitong 到 zhubo-analysis.conf');
}

async function deployXiangyu(conn) {
  const tmp = path.join(os.tmpdir(), `xy-path-${Date.now()}.tar.gz`);
  const items = ['client', 'config.server.json'];
  tar(items, tmp, XY_SRC);
  await put(conn, tmp, '/tmp/xiangyu-path.tar.gz');
  fs.unlinkSync(tmp);
  await exec(
    conn,
    `cd /opt/xiangyu && tar xzf /tmp/xiangyu-path.tar.gz && ` +
      `node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('config.server.json','utf8'));const cur=JSON.parse(fs.readFileSync('config.json','utf8'));cur.tunnel=c.tunnel;fs.writeFileSync('config.json',JSON.stringify(cur,null,2));" && ` +
      `pm2 restart xiangyu-web`
  );
}

async function main() {
  if (!PASSWORD) throw new Error('DEPLOY_SSH_PASSWORD required');
  const conn = await connect();
  try {
    await patchNginx(conn);
    await exec(conn, 'aa_nginx -t && aa_nginx -s reload');
    await deployXiangyu(conn);
    await exec(
      conn,
      `echo "=== xiangyuxitong ===" && ` +
        `curl -sk -o /dev/null -w "https:%{http_code}\\n" https://127.0.0.1/xiangyuxitong/ -H "Host: 8.137.126.18" && ` +
        `curl -sk https://127.0.0.1/xiangyuxitong/ -H "Host: 8.137.126.18" | head -c 120 && echo && ` +
        `echo "=== bridge ===" && curl -sk https://127.0.0.1/xiangyuxitong-bridge/health -H "Host: 8.137.126.18" && echo`
    );
    console.log('\n[deploy] 完成');
    console.log('  祥钰: https://8.137.126.18/xiangyuxitong/');
    console.log('  桥接: https://8.137.126.18/xiangyuxitong-bridge/health');
  } finally {
    conn.end();
  }
}

main().catch((e) => {
  console.error('[deploy]', e.message);
  process.exit(1);
});
