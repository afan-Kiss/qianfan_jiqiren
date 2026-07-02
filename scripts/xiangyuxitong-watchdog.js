#!/usr/bin/env node
/**
 * 祥钰系统保活：每 5 分钟 cron 执行
 * - 确保 Nginx 独立 snippet + include 存在
 * - 探测 /xiangyuxitong/ 与协议桥 health
 * - 异常时 reload nginx / 重启 pm2
 */
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const HOST = process.env.XIANGYU_WATCH_HOST || '8.137.126.18';
const LOG = process.env.XIANGYU_WATCH_LOG || '/var/log/xiangyuxitong-watchdog.log';
const ZHUBO_CONF = '/etc/aa_nginx/conf.d/zhubo-analysis.conf';
const SNIPPET = '/etc/aa_nginx/snippets/xiangyuxitong-locations.conf';
const INCLUDE_LINE = '    include /etc/aa_nginx/snippets/xiangyuxitong-locations.conf;';
const SNIPPET_SRC = path.join(__dirname, 'nginx-xiangyuxitong-locations.conf');
const PM2_APPS = ['xiangyu-web', 'qianfan-protocol-bridge'];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG, line);
  } catch {
    process.stdout.write(line);
  }
}

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function shOk(cmd) {
  try {
    sh(cmd);
    return true;
  } catch {
    return false;
  }
}

function ensureSnippet() {
  const content = fs.readFileSync(SNIPPET_SRC, 'utf8');
  fs.mkdirSync(path.dirname(SNIPPET), { recursive: true });
  const cur = fs.existsSync(SNIPPET) ? fs.readFileSync(SNIPPET, 'utf8') : '';
  if (cur !== content) {
    fs.writeFileSync(SNIPPET, content);
    log('updated nginx snippet');
    return true;
  }
  return false;
}

function stripInlineXiangyuBlocks(conf) {
  const patterns = [
    /[ \t]*# xiangyuxitong[^\n]*\n[\s\S]*?location = \/xiangyuxitong-bridge \{\n[\s\S]*?\}\n\n?/g,
    /[ \t]*location \/xiangyuxitong\/ \{[\s\S]*?\}\n\n?/g,
    /[ \t]*location = \/xiangyuxitong \{[\s\S]*?\}\n\n?/g,
    /[ \t]*location \/xiangyuxitong-bridge\/ \{[\s\S]*?\}\n\n?/g,
    /[ \t]*location = \/xiangyuxitong-bridge \{[\s\S]*?\}\n\n?/g,
  ];
  let next = conf;
  for (const re of patterns) next = next.replace(re, '');
  return next;
}

function ensureInclude() {
  if (!fs.existsSync(ZHUBO_CONF)) {
    log('WARN missing zhubo-analysis.conf');
    return false;
  }
  let conf = fs.readFileSync(ZHUBO_CONF, 'utf8');
  let changed = false;
  const cleaned = stripInlineXiangyuBlocks(conf);
  if (cleaned !== conf) {
    conf = cleaned;
    changed = true;
    log('removed inline xiangyuxitong blocks (use include)');
  }
  if (!conf.includes('xiangyuxitong-locations.conf')) {
    const anchor = '    location / {';
    const idx = conf.lastIndexOf(anchor);
    if (idx < 0) {
      log('WARN no location / anchor');
      return false;
    }
    conf = `${conf.slice(0, idx)}${INCLUDE_LINE}\n\n${conf.slice(idx)}`;
    changed = true;
    log('injected nginx include');
  }
  if (changed) {
    fs.writeFileSync(`${ZHUBO_CONF}.bak-watchdog`, conf);
    fs.writeFileSync(ZHUBO_CONF, conf);
  }
  return changed;
}

function reloadNginx() {
  if (!shOk('aa_nginx -t')) {
    log('ERROR nginx -t failed');
    return false;
  }
  shOk('aa_nginx -s reload');
  log('nginx reloaded');
  return true;
}

function pm2Online(name) {
  try {
    const raw = sh('pm2 jlist 2>/dev/null');
    const list = JSON.parse(raw);
    const hit = list.find((x) => x.name === name);
    return hit?.pm2_env?.status === 'online';
  } catch {
    return false;
  }
}

function restartPm2(names) {
  for (const name of names) {
    if (!pm2Online(name)) {
      shOk(`pm2 restart ${name} --update-env`);
      log(`restarted pm2 ${name}`);
    }
  }
}

function curlStatus(url) {
  try {
    return sh(
      `curl -sk -o /dev/null -w '%{http_code}' '${url}' -H 'Host: ${HOST}' --connect-timeout 10 --max-time 15`
    );
  } catch {
    return '0';
  }
}

function curlJson(url) {
  try {
    return sh(`curl -sk '${url}' -H 'Host: ${HOST}' --connect-timeout 10 --max-time 15`);
  } catch {
    return '';
  }
}

async function main() {
  let nginxChanged = ensureSnippet();
  nginxChanged = ensureInclude() || nginxChanged;
  if (nginxChanged) reloadNginx();

  restartPm2(PM2_APPS);

  const pageStatus = curlStatus('https://127.0.0.1/xiangyuxitong/');
  let bridge = { status: 0, ok: false };
  try {
    const raw = curlJson('https://127.0.0.1/xiangyuxitong-bridge/health');
    const json = raw ? JSON.parse(raw) : {};
    bridge = { status: 200, ok: Boolean(json.ok && json.protocolReady) };
  } catch {
    bridge = { status: 0, ok: false };
  }

  if (pageStatus !== '200') {
    log(`WARN page status=${pageStatus}, repairing...`);
    reloadNginx();
    shOk('pm2 restart xiangyu-web --update-env');
    sh('sleep 3');
    const again = curlStatus('https://127.0.0.1/xiangyuxitong/');
    log(`page after repair status=${again}`);
  }

  if (!bridge.ok) {
    log(`WARN bridge ready=${bridge.ok}, restarting bridge`);
    shOk('pm2 restart qianfan-protocol-bridge --update-env');
  }

  if (pageStatus === '200' && bridge.ok) {
    log('OK page=200 bridge=ready');
  }
}

main().catch((err) => {
  log(`ERROR ${err.message || err}`);
  process.exit(1);
});
