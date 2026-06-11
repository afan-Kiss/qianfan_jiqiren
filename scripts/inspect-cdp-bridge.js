const fs = require('fs');
const path = require('path');
const { getCdpBridgeConfig } = require('../src/shared/config');
const { ensureDir, resolveLogsDir } = require('../src/shared/app-root');
const { bridgeLog } = require('../src/shared/bridge-log');
const { ensureDebugClientReady } = require('../src/services/runtime/ensure-debug-client-ready');
const { CdpBridgeService } = require('../src/services/cdp/cdp-bridge-service');
const { closeBridgeDb } = require('../src/services/bridge/bridge-db');
const { healthSummaryLines } = require('../src/services/bridge/bridge-health');

function buildSuggestions(report) {
  const tips = [];
  if (!report.portDetect?.ok) {
    tips.push('未检测到 DevTools 端口：请用 --remote-debugging-port=9222 启动抖店/千帆客服台。');
    tips.push('本次未关闭客服台，未重新打开客服台（clientRuntime 默认只复用）。');
  }
  if (report.portDetect?.ok && !report.targetDiscover?.ok) {
    tips.push('有 DevTools 端口但未匹配客服页：请打开 IM/客服窗口，并检查 allowedUrlKeywords。');
  }
  if (report.targetDiscover?.ok && report.health?.injectedCount === 0) {
    tips.push('页面已识别但注入失败：刷新客服页后重试 inspect；查看 logs 中 [CDP_INJECT] 错误。');
  }
  if (report.health?.frameCount === 0) {
    tips.push('尚未收到 WebSocket 帧：在客服页切换会话或等待新消息，再运行 inspect。');
  }
  if (!tips.length) tips.push('桥接基本正常，可继续观察 logs/cdp-bridge-*.log 与 SQLite data/cdp-bridge.db。');
  return tips;
}

function writeReports(report) {
  const dir = ensureDir(resolveLogsDir());
  const jsonPath = path.join(dir, 'cdp-bridge-latest.json');
  const txtPath = path.join(dir, 'cdp-bridge-latest.txt');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  const lines = [
    'CDP Bridge Inspect Report',
    `generatedAt: ${report.generatedAt}`,
    '',
    '=== 客户端复用 ===',
    `reusedExistingClient: ${report.clientRuntime?.reusedExistingClient}`,
    `killedExistingClient: ${report.clientRuntime?.killedExistingClient}`,
    `relaunchedClient: ${report.clientRuntime?.relaunchedClient}`,
    `message: ${report.clientRuntime?.message || ''}`,
    '',
    '=== 端口检测 ===',
    JSON.stringify(report.portDetect, null, 2),
    '',
    '=== Target 列表 ===',
    ...(report.targets || []).map((t) => `- ${t.title} | ${t.url} | ${t.targetId}`),
    '',
    '=== 健康状态 ===',
    ...healthSummaryLines(report.health || {}),
    '',
    '=== WebSocket 连接 ===',
    ...(report.connections || []).slice(0, 20).map((c) => `- ${c.url} status=${c.status} target=${c.target_id}`),
    '',
    '=== 最近 20 条帧摘要 ===',
    ...(report.recentFrames || []).map(
      (f) => `- [${f.source}] ${f.direction} len=${f.payload_length || f.payloadLength} ${f.url || ''} ${(f.payload_text || f.payloadPreview || '').slice(0, 80)}`
    ),
    '',
    '=== 最近 20 条业务消息 ===',
    ...(report.recentBusiness || []).map(
      (m) => `- conf=${m.confidence} type=${m.message_type || m.messageType} content=${(m.content || '').slice(0, 80)}`
    ),
    '',
    '=== 错误 ===',
    ...(report.errors || []).map((e) => `- [${e.module}] ${e.message}`),
    '',
    '=== 下一步建议 ===',
    ...(report.suggestions || []).map((s) => `- ${s}`),
  ];
  fs.writeFileSync(txtPath, lines.join('\n'), 'utf8');
  return { jsonPath, txtPath };
}

async function main() {
  const cfg = getCdpBridgeConfig();
  bridgeLog('[BRIDGE_HEALTH]', '开始 CDP 桥 inspect');

  const clientRuntime = await ensureDebugClientReady();
  const portDetect = {
    ok: Boolean(clientRuntime.devtoolsPort),
    port: clientRuntime.devtoolsPort,
    host: '127.0.0.1',
    reason: clientRuntime.reason,
    ...(clientRuntime.portDetect || {}),
  };
  let targetDiscover = clientRuntime.targetDiscover || {
    ok: clientRuntime.ready,
    targets: clientRuntime.matchedTargets || [],
    allTargets: clientRuntime.allTargets || [],
  };
  if (!targetDiscover.targets?.length && clientRuntime.matchedTargets?.length) {
    targetDiscover = { ok: true, targets: clientRuntime.matchedTargets, allTargets: clientRuntime.allTargets };
  }

  const service = new CdpBridgeService();
  let health = {};
  let bridgeReport = {};
  try {
    if (cfg.enabled && clientRuntime.ready && targetDiscover.ok) {
      health = await service.start({ listenMs: Number(cfg.listenMs || 8000) });
      bridgeReport = service.getReport();
    } else {
      health = {
        devtoolsPortOk: portDetect.ok,
        devtoolsPort: portDetect.port || 0,
        cdpConnected: false,
        targetCount: targetDiscover.targets?.length || 0,
        injectedCount: 0,
        wsConnectionCount: 0,
        frameCount: 0,
        businessCount: 0,
        targets: targetDiscover.targets || [],
        connections: [],
        errors: [],
      };
    }
  } finally {
    await service.stop();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    clientRuntime: {
      reusedExistingClient: clientRuntime.reusedExistingClient,
      killedExistingClient: clientRuntime.killedExistingClient,
      relaunchedClient: clientRuntime.relaunchedClient,
      ready: clientRuntime.ready,
      reason: clientRuntime.reason,
      message: clientRuntime.message || '',
    },
    config: {
      enabled: cfg.enabled,
      ports: cfg.ports,
      debugPayload: cfg.debugPayload,
    },
    portDetect,
    targetDiscover: {
      ok: targetDiscover.ok,
      reason: targetDiscover.reason,
      totalPageCount: targetDiscover.totalPageCount,
    },
    targets: targetDiscover.targets || [],
    allTargets: (targetDiscover.allTargets || []).slice(0, 30),
    health,
    connections: bridgeReport.connections || service.db.getConnections(20),
    recentFrames: bridgeReport.recentFrames || service.db.getRecentFrames(20),
    recentBusiness: bridgeReport.recentBusiness || service.db.getRecentBusiness(20),
    errors: bridgeReport.errors || service.db.getErrors(20),
    stats: bridgeReport.stats || {},
    suggestions: [],
  };
  report.suggestions = buildSuggestions(report);

  const paths = writeReports(report);
  bridgeLog('[BRIDGE_HEALTH]', `报告已写入 ${paths.txtPath}`);
  closeBridgeDb();
  process.exit(clientRuntime.ready ? 0 : 1);
}

main().catch((err) => {
  bridgeLog('[BRIDGE_ERROR]', 'inspect 失败', String(err.message || err));
  closeBridgeDb();
  process.exit(2);
});
