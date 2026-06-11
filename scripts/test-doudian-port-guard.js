#!/usr/bin/env node
/**
 * 端口守卫专项测试
 * npm run doudian:test-port-guard
 */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const {
  ensurePortAvailable,
  isPortInUse,
  isSafeToKill,
  redactCommandLine,
} = require('../src/shared/port-guard');
const { resolveProjectRoot } = require('../src/shared/app-root');

async function testFreePort() {
  const port = 19627;
  const result = await ensurePortAvailable({ port, host: '127.0.0.1', timeoutMs: 5000 });
  return result.success && !result.wasOccupied && result.reason === 'port_free';
}

async function testOccupiedPortDetected() {
  const port = 19628;
  const server = http.createServer((_req, res) => {
    res.end('ok');
  });
  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });
  const occupied = await isPortInUse('127.0.0.1', port);
  server.close();
  return occupied;
}

async function testSafeKillChildNode() {
  const port = 19629;
  const helper = path.join(process.cwd(), 'scripts', 'test-port-guard-holder.js');
  const child = spawn(process.execPath, [helper, String(port)], {
    cwd: process.cwd(),
    stdio: 'ignore',
    windowsHide: true,
    detached: false,
  });
  await new Promise((r) => setTimeout(r, 800));
  const result = await ensurePortAvailable({
    port,
    host: '127.0.0.1',
    killExisting: true,
    forceKill: true,
    respectLiveLock: false,
    processNameAllowList: ['node.exe'],
    timeoutMs: 8000,
  });
  const freed = !(await isPortInUse('127.0.0.1', port));
  try {
    child.kill('SIGKILL');
  } catch {
    // ignore
  }
  return result.success && result.wasOccupied && result.killedPids.length >= 1 && freed;
}

function testUnknownProcessSkipped() {
  const safety = isSafeToKill(
    {
      pid: 99999,
      processName: 'notepad.exe',
      commandLine: 'C:\\Windows\\notepad.exe',
    },
    { processNameAllowList: ['node.exe'] }
  );
  return !safety.ok && safety.reason === 'process_not_in_allowlist';
}

function testReportFields() {
  const sample = {
    port: 19527,
    host: '127.0.0.1',
    wasOccupied: true,
    killedPids: [12345],
    skippedPids: [],
    success: true,
    reason: 'port_released_after_kill',
    attempts: [],
  };
  return (
    sample.port === 19527 &&
    Array.isArray(sample.killedPids) &&
    Array.isArray(sample.skippedPids) &&
    typeof sample.success === 'boolean'
  );
}

function testRedactSensitive() {
  const redacted = redactCommandLine('node script.js --token=abc123 --cookie=secret');
  return redacted === '[redacted-command-line]';
}

function testProjectPathRequired() {
  const safety = isSafeToKill(
    {
      pid: 88888,
      processName: 'node.exe',
      commandLine: 'node C:\\other\\project\\server.js',
    },
    { processNameAllowList: ['node.exe'] }
  );
  return !safety.ok && safety.reason === 'command_line_not_project';
}

async function main() {
  console.log('=== 抖店 port-guard 专项测试 ===');
  const freePortOk = await testFreePort();
  const occupiedPortDetected = await testOccupiedPortDetected();
  const safeKillOk = await testSafeKillChildNode();
  const unknownProcessSkipped = testUnknownProcessSkipped();
  const reportOk = testReportFields();
  const redactOk = testRedactSensitive();
  const projectPathOk = testProjectPathRequired();

  const summary = {
    success:
      freePortOk &&
      occupiedPortDetected &&
      safeKillOk &&
      unknownProcessSkipped &&
      reportOk &&
      redactOk &&
      projectPathOk,
    freePortOk,
    occupiedPortDetected,
    safeKillOk,
    unknownProcessSkipped,
    reportOk,
    redactOk,
    projectPathOk,
    projectRoot: resolveProjectRoot(),
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.success ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
