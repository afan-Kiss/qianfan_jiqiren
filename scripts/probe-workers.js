const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getWorkerEntries } = require('../src/runtime/worker-registry');
const { resolveProjectRoot, resolveRuntimeRoot, resolveLogsDir } = require('../src/shared/app-root');

const rootDir = resolveProjectRoot();
const runtimeRoot = resolveRuntimeRoot();
const logsDir = resolveLogsDir();
fs.mkdirSync(logsDir, { recursive: true });

const workers = getWorkerEntries(runtimeRoot);
const names = Object.keys(workers);

async function probe(name, entry) {
  return new Promise((resolve) => {
    const logFile = path.join(logsDir, `probe-${name}.log`);
    const out = fs.createWriteStream(logFile, { flags: 'a' });
    const child = fork(entry, [], {
      cwd: rootDir,
      env: {
        ...process.env,
        QIANFAN_SKIP_LICENSE_CHECK: '1',
        QIANFAN_WORKER_NAME: name,
        QIANFAN_RUNTIME_MODE: 'distributed',
        QIANFAN_APP_ROOT: rootDir,
        QIANFAN_RUNTIME_ROOT: runtimeRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let stderr = '';
    child.stderr?.on('data', (c) => {
      const t = String(c);
      stderr += t;
      out.write(t);
    });
    child.stdout?.on('data', (c) => out.write(String(c)));

    const timer = setTimeout(() => {
      child.kill();
      resolve({ name, ok: true, note: 'still running after 5s', logFile });
    }, 5000);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ name, ok: code === 0, code, signal, stderr: stderr.trim(), logFile });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ name, ok: false, error: err.message, logFile });
    });
  });
}

(async () => {
  console.log('rootDir:', rootDir);
  console.log('runtimeRoot:', runtimeRoot);
  for (const name of names) {
    const entry = workers[name];
    console.log('\n=== probe', name, '===');
    console.log('entry:', entry, 'exists:', fs.existsSync(entry));
    const result = await probe(name, entry);
    console.log(JSON.stringify(result, null, 2));
  }
})();
