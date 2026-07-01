#!/usr/bin/env node
/**
 * 公司电脑配置刷新代理：tap 刷新 local.json → 校验 → 上传服务器 → reload
 */
const fs = require('fs');
const path = require('path');
const { applyTapToShopConfig } = require('../src/protocol/qianfan-protocol-tap-config');
const { localConfigPath, readJsonFile } = require('../src/protocol/qianfan-protocol-config');
const { validateProtocolConfigShops } = require('../src/protocol/qianfan-protocol-config-validator');
const {
  formatConfigAgentFailureNotice,
  sendDaemonWxNotify,
} = require('../src/protocol/qianfan-protocol-daemon-notify');
const { fetchWithTimeout } = require('../src/fetch-timeout');
const { println } = require('../src/utils');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_FAIL_NOTIFY_THRESHOLD = 3;

function parseArgs(argv) {
  const out = {
    once: false,
    help: false,
    intervalMs: Number(process.env.QIANFAN_PROTOCOL_CONFIG_AGENT_INTERVAL_MS || DEFAULT_INTERVAL_MS),
    serverUrl: String(process.env.QIANFAN_PROTOCOL_SERVER_URL || 'http://127.0.0.1:9324').replace(/\/$/, ''),
    uploadToken: String(process.env.QIANFAN_PROTOCOL_CONFIG_UPLOAD_TOKEN || '').trim(),
    failNotifyThreshold: Number(
      process.env.QIANFAN_PROTOCOL_CONFIG_AGENT_FAIL_NOTIFY || DEFAULT_FAIL_NOTIFY_THRESHOLD
    ),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--once') out.once = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--interval-ms') out.intervalMs = Number(argv[++i]) || out.intervalMs;
    else if (a === '--server') out.serverUrl = String(argv[++i] || out.serverUrl).replace(/\/$/, '');
  }
  return out;
}

function loadLocalShops(configPath) {
  if (!fs.existsSync(configPath)) return [];
  return readJsonFile(configPath);
}

function refreshShopsFromTap(shops) {
  const merged = [];
  for (const shop of shops) {
    if (!shop?.shopTitle) {
      merged.push(shop);
      continue;
    }
    const applied = applyTapToShopConfig(shop, { shopTitle: shop.shopTitle });
    merged.push(applied.config);
  }
  return merged;
}

function writeLocalConfig(configPath, shops) {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${configPath}.agent.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(shops, null, 2), 'utf8');
  fs.renameSync(tmp, configPath);
}

async function uploadConfig(serverUrl, shops, uploadToken) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (uploadToken) headers['X-Protocol-Token'] = uploadToken;

  const res = await fetchWithTimeout(
    `${serverUrl}/api/qianfan/protocol/config/upload`,
    { method: 'POST', headers, body: JSON.stringify(shops) },
    30000
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(json?.error || `upload HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function reloadServer(serverUrl, uploadToken) {
  const headers = { Accept: 'application/json' };
  if (uploadToken) headers['X-Protocol-Token'] = uploadToken;
  const res = await fetchWithTimeout(
    `${serverUrl}/api/qianfan/protocol/reload`,
    { method: 'POST', headers },
    15000
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `reload HTTP ${res.status}`);
  return json;
}

async function runCycle(args, state) {
  const configPath = localConfigPath();
  const base = loadLocalShops(configPath);
  if (!base.length) throw new Error(`本地配置为空: ${configPath}`);

  const refreshed = refreshShopsFromTap(base);
  writeLocalConfig(configPath, refreshed);

  const validation = validateProtocolConfigShops(refreshed);
  if (!validation.ok) {
    throw new Error(`配置校验失败: ${validation.errors.join('; ')}`);
  }

  const upload = await uploadConfig(args.serverUrl, refreshed, args.uploadToken);
  const reload = await reloadServer(args.serverUrl, args.uploadToken);

  state.failCount = 0;
  state.lastOkAt = Date.now();
  state.lastError = '';
  println(
    `[config-agent] 刷新成功 shops=${validation.shopCount} canWsSend=${validation.canWsSendCount} upload=${upload?.uploaded || 0}`
  );
  return { validation, upload, reload };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      '用法: node scripts/qianfan-protocol-config-agent.js [--once] [--server http://host:9324] [--interval-ms 300000]'
    );
    process.exit(0);
  }

  const state = { failCount: 0, lastError: '', lastOkAt: 0 };

  const tick = async () => {
    try {
      await runCycle(args, state);
    } catch (err) {
      state.failCount += 1;
      state.lastError = err.message || String(err);
      println(`[config-agent] 刷新失败 #${state.failCount}: ${state.lastError}`);
      if (state.failCount >= args.failNotifyThreshold) {
        await sendDaemonWxNotify(
          formatConfigAgentFailureNotice({
            failCount: state.failCount,
            lastError: state.lastError,
          })
        );
        state.failCount = 0;
      }
    }
  };

  await tick();
  if (args.once) return;

  setInterval(() => void tick(), Math.max(30000, args.intervalMs));
  println(`[config-agent] 已启动，间隔 ${args.intervalMs}ms → ${args.serverUrl}`);
}

main().catch((err) => {
  console.error('[config-agent] 致命错误:', err.message || err);
  process.exit(1);
});
