const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const PASSWORD = process.env.DEPLOY_SSH_PASSWORD || '';
const CONF = '/etc/aa_nginx/conf.d/zhubo-analysis.conf';
const MARKER = '# xiangyu-pack-photo';
const snippet = fs.readFileSync(path.join(__dirname, '_nginx-xiangyu-locations.snippet'), 'utf8');

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

function putContent(conn, remote, content) {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  return exec(conn, `echo '${b64}' | base64 -d > ${remote}`);
}

async function main() {
  if (!PASSWORD) throw new Error('DEPLOY_SSH_PASSWORD required');
  const conn = await connect();
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

  if (conf.includes(MARKER)) {
    console.log('[nginx] 已存在 xiangyu 路径，跳过注入');
  } else {
    const anchor = '    location / {';
    const idx = conf.lastIndexOf(anchor);
    if (idx < 0) throw new Error('未找到 location / 锚点');
    conf = conf.slice(0, idx) + snippet + '\n' + conf.slice(idx);
    await exec(conn, `cp ${CONF} ${CONF}.bak-xiangyu`);
    await putContent(conn, CONF, conf);
    console.log('[nginx] 已注入 xiangyu 路径到 zhubo-analysis.conf');
  }

  await exec(conn, 'aa_nginx -t && aa_nginx -s reload');
  await exec(
    conn,
    `curl -s -o /dev/null -w "xiangyu:%{http_code}\\n" http://127.0.0.1/xiangyu-proxy/ -H "Host: 8.137.126.18" && ` +
      `curl -s http://127.0.0.1/xiangyu-bridge/health -H "Host: 8.137.126.18" && echo`
  );
  conn.end();
}

main().catch((e) => {
  console.error('[nginx]', e.message);
  process.exit(1);
});
