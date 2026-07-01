#!/usr/bin/env node
/**
 * 千帆纯协议守护进程（服务器常驻）
 * - 读取 config/qianfan-protocol-shops.local.json
 * - WS 实时监听 + HTTP 兜底轮询
 * - 微信通知 + 凭证失效告警
 */
const fs = require('fs');
const { QianfanProtocolDaemon } = require('../src/protocol/qianfan-protocol-daemon-core');
const { createDaemonApiServer } = require('../src/protocol/qianfan-protocol-daemon-api');
const { localConfigPath } = require('../src/protocol/qianfan-protocol-config');
const { println } = require('../src/utils');

function parseArgs(argv) {
  const out = { help: false, withTap: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--with-tap') out.withTap = true;
    else if (a === '--no-tap') out.withTap = false;
    else if (a === '--config') out.configPath = String(argv[++i] || '').trim();
  }
  return out;
}

function watchConfigFile(daemon, configPath) {
  let timer = null;
  let lastMtime = 0;
  const debounceMs = 1200;
  const tick = async () => {
    try {
      const stat = fs.statSync(configPath);
      if (lastMtime && stat.mtimeMs === lastMtime) return;
      lastMtime = stat.mtimeMs;
      await daemon.reloadConfig('fs_watch');
    } catch (err) {
      println(`[protocol-daemon] 配置热加载失败: ${err.message || err}`);
    }
  };
  try {
    lastMtime = fs.statSync(configPath).mtimeMs;
  } catch {
    // ignore
  }
  fs.watch(configPath, { persistent: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), debounceMs);
  });
  println(`[protocol-daemon] 已监听配置热加载: ${configPath}`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法: node scripts/qianfan-protocol-daemon.js [--config path] [--no-tap]');
    process.exit(0);
  }

  const configPath = args.configPath || localConfigPath();
  const useTapOnLoad =
    args.withTap || process.env.QIANFAN_PROTOCOL_DAEMON_USE_TAP === '1';
  const daemon = new QianfanProtocolDaemon({
    configPath,
    useTapOnLoad,
  });
  const api = createDaemonApiServer(daemon);

  const shutdown = async (signal) => {
    println(`[protocol-daemon] 收到 ${signal}，正在退出...`);
    try {
      await daemon.stop();
      await api.stop();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await api.start();
  await daemon.start();
  watchConfigFile(daemon, configPath);

  println('[protocol-daemon] 守护进程已启动');
}

main().catch((err) => {
  console.error('[protocol-daemon] 启动失败:', err.message || err);
  process.exit(1);
});
