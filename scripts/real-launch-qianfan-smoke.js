const fs = require('fs');
const { execSync } = require('child_process');
const {
  ensureQianfanDevToolsReady,
  isQianfanProcessRunning,
  probeDevTools,
  waitForProcessExit,
  DEFAULT_CLIENT_EXE,
  DEFAULT_CLIENT_PROCESS,
} = require('../src/qianfan-client-launcher');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('[real-launch-qianfan-smoke] SKIP: not Windows');
    return;
  }

  if (!fs.existsSync(DEFAULT_CLIENT_EXE)) {
    console.log(`[real-launch-qianfan-smoke] SKIP: exe not found at ${DEFAULT_CLIENT_EXE}`);
    return;
  }

  console.log('[real-launch-qianfan-smoke] step 1: kill existing qianfan process');
  try {
    execSync(`taskkill /F /IM "${DEFAULT_CLIENT_PROCESS}"`, { stdio: 'ignore' });
  } catch {
    // no running process
  }
  await waitForProcessExit(DEFAULT_CLIENT_PROCESS, 8000);
  await sleep(1000);

  console.log('[real-launch-qianfan-smoke] step 2: ensureQianfanDevToolsReady');
  const result = await ensureQianfanDevToolsReady({}, {
    canLaunch: true,
    log: (level, message) => console.log(`[${level}] ${message}`),
  });

  console.log('[real-launch-qianfan-smoke] step 3: verify process and devtools');
  const processRunning = isQianfanProcessRunning(DEFAULT_CLIENT_PROCESS);
  const probe = await probeDevTools({ devtoolsPort: 9223, devtoolsHost: '127.0.0.1' });

  console.log('[real-launch-qianfan-smoke] RESULT:');
  console.log(`  ensureQianfanDevToolsReady.ok = ${result.ok}`);
  console.log(`  ensureQianfanDevToolsReady.phase = ${result.phase || 'n/a'}`);
  if (result.lastError) console.log(`  ensureQianfanDevToolsReady.lastError = ${result.lastError}`);
  console.log(`  tasklist process = ${processRunning ? '存在' : '不存在'}`);
  console.log(`  /json/version = ${probe.ok ? '成功' : '失败'}`);
  if (probe.ok && probe.browser) console.log(`  browser = ${probe.browser}`);

  if (!result.ok || !processRunning || !probe.ok) {
    throw new Error('real qianfan launch smoke test failed');
  }

  console.log('[real-launch-qianfan-smoke] PASSED');
}

main().catch((err) => {
  console.error('[real-launch-qianfan-smoke] FAILED');
  console.error(err.message || err);
  process.exit(1);
});
