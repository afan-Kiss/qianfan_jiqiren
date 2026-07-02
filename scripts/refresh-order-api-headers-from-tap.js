#!/usr/bin/env node
/** 从 tap 日志刷新 order API 签名头到 local 配置 */
const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { readExistingLocalConfig, saveLocalProtocolConfig } = require('../src/protocol/qianfan-live-context-extractor');
const { resolveProjectRoot } = require('../src/shared/app-root');

const MAP = [
  { key: 'orderSearchList', re: /package\/search-list/i },
  { key: 'packageDetail', re: /\/package\/P\d+\/detail$/i },
  { key: 'packageDecrypt', re: /get\/package\/decrypt/i },
  { key: 'sensitiveInfoMobile', re: /get_sensitive_info.*MOBILE/i },
  { key: 'sensitiveInfoAddress', re: /get_sensitive_info.*ADDRESS/i },
  { key: 'sensitiveInfoName', re: /get_sensitive_info.*NAME/i },
];

function todayLog() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(resolveProjectRoot(), 'logs', 'debug', `qianfan-protocol-tap-${y}-${m}-${day}.jsonl`);
}

function pickHeaders(h) {
  const keys = ['Authorization', 'X-S-Common', 'X-s', 'X-t', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'User-Agent', 'Referer', 'x-subsystem'];
  const out = {};
  for (const k of keys) {
    if (h[k]) out[k] = h[k];
  }
  return out;
}

async function main() {
  const logPath = process.argv[2] || todayLog();
  const latest = {};
  const rl = readline.createInterface({ input: fs.createReadStream(logPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.kind !== 'http_request') continue;
    const url = String(o.url || '');
    for (const m of MAP) {
      if (m.re.test(url)) latest[m.key] = pickHeaders(o.headers || {});
    }
  }
  const shops = readExistingLocalConfig();
  for (const shop of shops) {
    shop.httpTemplates = shop.httpTemplates || {};
    for (const m of MAP) {
      if (latest[m.key]) {
        shop.httpTemplates[m.key] = shop.httpTemplates[m.key] || {};
        shop.httpTemplates[m.key].headers = { ...(shop.httpTemplates[m.key].headers || {}), ...latest[m.key] };
      }
    }
  }
  saveLocalProtocolConfig(shops);
  console.log('[tap-headers] 已刷新:', Object.keys(latest).join(', '));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
