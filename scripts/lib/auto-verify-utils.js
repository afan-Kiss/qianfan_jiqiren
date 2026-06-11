const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { resolveProjectRoot, resolveLogsDir, ensureDir } = require('../../src/shared/app-root');
const { ensurePortAvailable } = require('../../src/shared/port-guard');
const { getDoudianConfig } = require('../../src/shared/config');
const {
  acquireDoudianLiveLock,
  releaseDoudianLiveLock,
  registerDoudianLiveLockCleanup,
  parseForceKill,
  buildBlockedLiveReport,
} = require('../../src/platforms/doudian/doudian-run-lock');
const {
  ORIGINAL_INSTALL_DIR,
  TEST_INSTALL_DIR,
  KILL_PROCESS_NAMES,
  KILL_PROCESS_WARN_ONLY,
  KEY_FILES_AFTER_COPY,
  OPTIONAL_KEY_FILES,
} = require('../../src/platforms/doudian/doudian-asar-patch-constants');

const SENSITIVE_PATTERNS = [
  /cookie/i,
  /authorization/i,
  /token/i,
  /csrf/i,
  /x-ms-token/i,
  /bd-ticket/i,
  /x-tt-session-sign/i,
  /sessionid/i,
];

function redactText(text) {
  let out = String(text || '');
  for (const re of SENSITIVE_PATTERNS) {
    if (re.test(out)) return '[redacted-log-line]';
  }
  return out.length > 500 ? `${out.slice(0, 500)}...[truncated]` : out;
}

function runCommand(cmd, options = {}) {
  try {
    const output = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout || 120000,
      windowsHide: true,
    });
    return { ok: true, output: redactText(output) };
  } catch (err) {
    const stderr = redactText(err.stderr || err.message || String(err));
    const stdout = redactText(err.stdout || '');
    return {
      ok: false,
      output: stdout,
      error: stderr,
      exitCode: err.status,
    };
  }
}

function killDoudianProcesses() {
  const results = [];
  for (const name of [...KILL_PROCESS_NAMES, ...KILL_PROCESS_WARN_ONLY]) {
    const r = runCommand(`taskkill /F /IM ${name}`, { timeout: 15000 });
    const warnOnly = KILL_PROCESS_WARN_ONLY.includes(name);
    const entry = {
      process: name,
      ok: r.ok,
      warnOnly,
      output: r.output || r.error || '',
    };
    if (!r.ok && warnOnly) {
      entry.warning = '拒绝访问或进程不存在，已记录 warning 并继续';
    }
    results.push(entry);
  }
  return results;
}

function getDiskFreeBytes(drive = 'D:') {
  try {
    const out = execSync(`powershell -NoProfile -Command "(Get-PSDrive -Name '${drive.replace(':', '')}').Free"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Number(String(out).trim()) || 0;
  } catch {
    return 0;
  }
}

function getDirSizeBytes(dir) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-ChildItem -LiteralPath '${dir.replace(/'/g, "''")}' -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 300000 }
    );
    return Number(String(out).trim()) || 0;
  } catch {
    return 0;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatTs(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function verifyKeyFiles(installDir) {
  const missing = [];
  const present = [];
  for (const rel of KEY_FILES_AFTER_COPY) {
    const full = path.join(installDir, rel);
    if (fs.existsSync(full)) present.push(rel);
    else missing.push(rel);
  }
  const optional = [];
  for (const rel of OPTIONAL_KEY_FILES) {
    optional.push({ path: rel, exists: fs.existsSync(path.join(installDir, rel)) });
  }
  return { ok: missing.length === 0, missing, present, optional };
}

function writeReports(report, options = {}) {
  const prefix = options.prefix || 'doudian-auto-verify';
  const logsDir = ensureDir(resolveLogsDir());
  const stamp = formatTs(new Date(report.startedAt || Date.now()));
  const jsonLatest = path.join(logsDir, `${prefix}-latest.json`);
  const txtLatest = path.join(logsDir, `${prefix}-latest.txt`);
  const jsonStamp = path.join(logsDir, `${prefix}-${stamp}.json`);
  const txtStamp = path.join(logsDir, `${prefix}-${stamp}.txt`);

  const json = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(jsonLatest, json, 'utf8');
  fs.writeFileSync(jsonStamp, json, 'utf8');

  const builder = options.buildTextReport || buildTextReport;
  const lines = builder(report);
  const txt = `${lines.join('\n')}\n`;
  fs.writeFileSync(txtLatest, txt, 'utf8');
  fs.writeFileSync(txtStamp, txt, 'utf8');

  return { jsonLatest, txtLatest, jsonStamp, txtStamp };
}

function buildImTextReport(report) {
  const lines = [];
  lines.push('=== 抖店 IM 客服页 bridge 自动验证报告 ===');
  lines.push(`时间: ${report.finishedAt || new Date().toISOString()}`);
  lines.push(`IM bridge 结果: ${report.imBridgeSuccess ? '成功' : '失败'}`);
  lines.push(`首页 bridge: ${report.homepageBridgeSuccess ? '成功' : '失败'}`);
  if (!report.imBridgeSuccess && report.failStep) lines.push(`失败步骤: ${report.failStep}`);
  lines.push('');
  lines.push(`原始目录: ${report.originalInstallDir}`);
  lines.push(`测试目录: ${report.testInstallDir}`);
  lines.push(`bridgePort: ${report.bridgePort}`);
  lines.push(`imWaitMs: ${report.imWaitMs || 180000}`);
  lines.push(`bridge 数量: ${report.bridgeCount || 0}`);
  lines.push(`IM heartbeat: ${report.imHeartbeatCount || 0}`);
  lines.push('');
  if (report.firstHomepageBridge) {
    lines.push(`firstHomepageBridge: ${JSON.stringify(report.firstHomepageBridge)}`);
  }
  if (report.firstImBridge) {
    lines.push(`firstImBridge: ${JSON.stringify(report.firstImBridge)}`);
  } else {
    lines.push('firstImBridge: null');
  }
  if (report.allBridges?.length) {
    lines.push('');
    lines.push('allBridges:');
    for (const b of report.allBridges) {
      lines.push(
        `- ${b.bridgeId} homepage=${b.isHomepage} im=${b.isImWorkspace} hb=${b.heartbeatCount} hrefs=${JSON.stringify(b.hrefs)}`
      );
    }
  }
  if (report.imOpenAttempts?.length) {
    lines.push('');
    lines.push('imOpenAttempts:');
    for (const a of report.imOpenAttempts) {
      lines.push(`- ${new Date(a.at).toISOString()} reason=${a.reason} sent=${JSON.stringify(a.sent)}`);
    }
  }
  if (report.warnings?.length) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  if (report.errors?.length) {
    lines.push('');
    lines.push('Errors:');
    for (const e of report.errors) lines.push(`- ${e}`);
  }
  if (report.nextActions?.length) {
    lines.push('');
    lines.push('Next actions:');
    for (const a of report.nextActions) lines.push(`- ${a}`);
  }
  return lines;
}

function buildTextReport(report) {
  const lines = [];
  lines.push('=== 抖店 bridge 自动验证报告 ===');
  lines.push(`时间: ${report.finishedAt || new Date().toISOString()}`);
  lines.push(`结果: ${report.success ? '成功' : '失败'}`);
  if (!report.success && report.failStep) lines.push(`失败步骤: ${report.failStep}`);
  lines.push('');
  lines.push(`原始目录: ${report.originalInstallDir}`);
  lines.push(`测试目录: ${report.testInstallDir}`);
  lines.push(`bridgePort: ${report.bridgePort}`);
  lines.push('');
  if (report.firstBridgeHello) {
    lines.push(`firstBridgeHello: ${JSON.stringify(report.firstBridgeHello)}`);
  }
  lines.push(`heartbeatCount: ${report.heartbeatCount || 0}`);
  if (report.warnings?.length) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  if (report.errors?.length) {
    lines.push('');
    lines.push('Errors:');
    for (const e of report.errors) lines.push(`- ${e}`);
  }
  if (report.nextActions?.length) {
    lines.push('');
    lines.push('Next actions:');
    for (const a of report.nextActions) lines.push(`- ${a}`);
  }
  return lines;
}

function buildListenTextReport(report) {
  const lines = [];
  const lr = report.listenResult || report;
  lines.push('=== 抖店多店铺 IM 消息监听验证报告 ===');
  lines.push(`时间: ${report.finishedAt || new Date().toISOString()}`);
  lines.push(`结果: ${report.success ? '成功' : '失败'}`);
  lines.push(`success: ${report.success}`);
  lines.push(`bridgeSuccess: ${lr.bridgeSuccess ?? report.bridgeSuccess}`);
  lines.push(`observerReady: ${lr.observerReady ?? (report.observerReadyCount > 0)}`);
  lines.push(`shopIdentitySuccess: ${lr.shopIdentitySuccess ?? report.shopIdentitySuccess}`);
  lines.push(`businessDataCaptured: ${lr.businessDataCaptured ?? report.businessDataCaptured}`);
  lines.push(`realMessageCandidateCaptured: ${lr.realMessageCandidateCaptured ?? report.realMessageCandidateCaptured}`);
  lines.push(`onlyUiNoiseCaptured: ${lr.onlyUiNoiseCaptured ?? report.onlyUiNoiseCaptured}`);
  lines.push(`multiShopDetected: ${report.multiShopDetected}`);
  const loggedInCount =
    lr.loggedInShopCount ??
    report.loggedInShopCount ??
    (Array.isArray(lr.loggedInShops) ? lr.loggedInShops.length : lr.loggedInShops) ??
    (Array.isArray(report.loggedInShops) ? report.loggedInShops.length : report.loggedInShops) ??
    0;
  const activeImCount =
    lr.activeImShopCount ??
    report.activeImShopCount ??
    (Array.isArray(lr.activeImShops) ? lr.activeImShops.length : lr.activeImShops) ??
    (Array.isArray(report.activeImShops) ? report.activeImShops.length : report.activeImShops) ??
    0;
  const inactiveCount =
    lr.inactiveShopCount ??
    report.inactiveShopCount ??
    (Array.isArray(lr.inactiveShops) ? lr.inactiveShops.length : lr.inactiveShops) ??
    (Array.isArray(report.inactiveShops) ? report.inactiveShops.length : report.inactiveShops) ??
    0;
  lines.push(`loggedInShopCount: ${loggedInCount}`);
  lines.push(`activeImShopCount: ${activeImCount}`);
  lines.push(`inactiveShopCount: ${inactiveCount}`);
  if (!report.success && report.failStep) lines.push(`失败步骤: ${report.failStep}`);
  lines.push('');
  lines.push(`workerNetworkCandidateCount: ${lr.workerNetworkCandidateCount ?? 0}`);
  lines.push(`memoryCacheCandidateCount: ${lr.memoryCacheCandidateCount ?? 0}`);
  lines.push(`memoryCacheBusinessEventCount: ${lr.memoryCacheBusinessEventCount ?? 0}`);
  lines.push(`shopIdentityEventCount: ${lr.shopIdentityEventCount ?? 0}`);
  lines.push(`conversationListEventCount: ${lr.conversationListEventCount ?? 0}`);
  lines.push(`conversationEmptyEventCount: ${lr.conversationEmptyEventCount ?? 0}`);
  lines.push(`realMessageCandidateEventCount: ${lr.realMessageCandidateEventCount ?? 0}`);
  lines.push(`platformConversationUpsertCount: ${lr.platformConversationUpsertCount ?? 0}`);
  lines.push(`platformMessageInsertCount: ${lr.platformMessageInsertCount ?? 0}`);
  lines.push(`stdoutBusinessSignalCount: ${lr.stdoutBusinessSignalCount ?? 0}`);
  lines.push(`currentUserCaptured: ${lr.currentUserCaptured ?? false}`);
  lines.push(`conversationListCaptured: ${lr.conversationListCaptured ?? false}`);
  lines.push(`linkInfoCaptured: ${lr.linkInfoCaptured ?? false}`);
  lines.push(`realConversationCount: ${lr.realConversationCount ?? 0}`);
  lines.push(`realMessageCandidateCount: ${lr.realMessageCandidateCount ?? 0}`);
  lines.push(`uiNoiseCount: ${lr.uiNoiseCount ?? 0}`);
  lines.push(`domCandidateCount: ${lr.domCandidateCount ?? report.domCandidateCount ?? 0}`);
  lines.push(`emptyStateDetected: ${lr.emptyStateDetected ?? report.emptyStateDetected ?? false}`);
  lines.push('');
  if (lr.uiNoiseSamples?.length || report.uiNoiseSamples?.length) {
    lines.push('uiNoiseSamples:');
    for (const s of (lr.uiNoiseSamples || report.uiNoiseSamples || []).slice(0, 10)) lines.push(`- ${s}`);
  }
  if (lr.realMessageSamples?.length || report.realMessageSamples?.length) {
    lines.push('realMessageSamples:');
    for (const m of (lr.realMessageSamples || report.realMessageSamples || []).slice(0, 10)) {
      lines.push(`- ${JSON.stringify(m)}`);
    }
  }
  if (report.shops?.length) {
    lines.push('');
    lines.push('shops:');
    for (const s of report.shops) {
      lines.push(
        `- ${s.shopKey} id=${s.shopId} name=${s.shopName} activeIm=${s.activeImBridgeId} observerReady=${s.observerReady}`
      );
    }
  }
  if (report.warnings?.length) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  if (report.errors?.length) {
    lines.push('');
    lines.push('Errors:');
    for (const e of report.errors) lines.push(`- ${e}`);
  }
  if (report.nextActions?.length) {
    lines.push('');
    lines.push('Next actions:');
    for (const a of report.nextActions) lines.push(`- ${a}`);
  }
  return lines;
}

function getEnvInfo() {
  let npmVersion = '';
  try {
    npmVersion = execSync('npm -v', { encoding: 'utf8' }).trim();
  } catch {
    npmVersion = 'unknown';
  }
  return {
    cwd: process.cwd(),
    nodeVersion: process.version,
    npmVersion,
    projectRoot: resolveProjectRoot(),
    originalInstallDir: ORIGINAL_INSTALL_DIR,
    testInstallDir: TEST_INSTALL_DIR,
    startedAt: new Date().toISOString(),
  };
}

function isDoudianRunning() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-Process doudian -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return String(out)
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => Number(id));
  } catch {
    return [];
  }
}

async function startBridgeWsServer(wsServer, report) {
  try {
    await wsServer.start();
    report.portGuard = wsServer.lastPortGuard || null;
    return true;
  } catch (err) {
    report.portGuard = err.portGuard ||
      wsServer.lastPortGuard || {
        port: wsServer.port,
        host: '127.0.0.1',
        wasOccupied: true,
        killedPids: [],
        skippedPids: [],
        success: false,
        reason: 'port_guard_failed',
      };
    report.success = false;
    report.reason = report.portGuard.reason || 'port_guard_failed';
    if (!report.errors) report.errors = [];
    report.errors.push(`端口守卫/WS 启动失败: ${report.portGuard.reason || err.message || err}`);
    return false;
  }
}

async function ensureBridgePortAvailable(options = {}) {
  const cfg = getDoudianConfig();
  const port = Number(options.port || cfg.bridgePort || 19527);
  const host = options.host || '127.0.0.1';
  const forceKill = !!options.forceKill;
  const result = await ensurePortAvailable({
    port,
    host,
    forceKill,
    respectLiveLock: options.respectLiveLock !== false,
    lockPath: options.lockPath,
    killExisting: options.killExisting !== undefined ? options.killExisting !== false : true,
    processNameAllowList: options.processNameAllowList || ['node.exe'],
    timeoutMs: Number(options.timeoutMs || 10000),
  });
  if (!result.success) {
    console.error(`[port-guard] 端口 ${host}:${port} 未能安全释放，reason=${result.reason}`);
    if (result.skippedPids?.length) {
      console.error(`[port-guard] skippedPids=${result.skippedPids.join(',')}`);
    }
  } else if (result.wasOccupied) {
    console.log(
      `[port-guard] 端口 ${host}:${port} 已释放 killedPids=${(result.killedPids || []).join(',') || '(none)'}`
    );
  }
  return result;
}

async function beginDoudianLiveRun(options = {}) {
  const cfg = getDoudianConfig();
  const argv = options.argv || [];
  const bridgePort = Number(options.port || cfg.bridgePort || 19527);
  const command = String(options.command || 'doudian:live');
  const forceKill = parseForceKill(argv);

  const runLock = acquireDoudianLiveLock({
    command,
    port: bridgePort,
    forceKill,
  });

  if (!runLock.acquired) {
    const report = buildBlockedLiveReport(runLock, {
      command,
      bridgePort,
      ...(options.blockedReportExtra || {}),
    });
    if (options.reportPrefix) {
      writeReports(report, {
        prefix: options.reportPrefix,
        buildTextReport: options.buildTextReport,
      });
    }
    console.error(
      `[run-lock] 已有抖店 live 任务运行中: pid=${runLock.existingTask?.pid || ''} command=${runLock.existingTask?.command || ''}`
    );
    console.error('[run-lock] 请先关闭旧任务，或使用 --force-kill 强制结束');
    process.exit(0);
  }

  registerDoudianLiveLockCleanup();

  const portGuard = await ensureBridgePortAvailable({
    port: bridgePort,
    forceKill,
  });

  if (!portGuard.success) {
    releaseDoudianLiveLock();
    const report = buildBlockedLiveReport(runLock, {
      command,
      bridgePort,
      portGuard,
      reason: portGuard.reason,
      ...(options.blockedReportExtra || {}),
    });
    if (options.reportPrefix) {
      writeReports(report, {
        prefix: options.reportPrefix,
        buildTextReport: options.buildTextReport,
      });
    }
    console.error(`[port-guard] 端口 ${bridgePort} 未能安全使用，reason=${portGuard.reason}`);
    process.exit(portGuard.reason === 'another_doudian_task_running' ? 0 : 1);
  }

  return { runLock, portGuard, forceKill, bridgePort };
}

module.exports = {
  ORIGINAL_INSTALL_DIR,
  TEST_INSTALL_DIR,
  redactText,
  runCommand,
  killDoudianProcesses,
  getDiskFreeBytes,
  getDirSizeBytes,
  sleep,
  verifyKeyFiles,
  writeReports,
  buildTextReport,
  buildImTextReport,
  buildListenTextReport,
  getEnvInfo,
  isDoudianRunning,
  ensureBridgePortAvailable,
  beginDoudianLiveRun,
  parseForceKill,
  startBridgeWsServer,
};
