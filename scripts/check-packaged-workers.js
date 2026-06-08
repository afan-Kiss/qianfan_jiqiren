const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const { START_ORDER, getWorkerEntries } = require('../src/runtime/worker-registry');

const distRoot = process.env.QIANFAN_PACKAGED_ROOT
  ? path.resolve(process.env.QIANFAN_PACKAGED_ROOT)
  : path.resolve(__dirname, '..', 'dist', 'build-new', 'win-unpacked');
const runtimeRoot = path.join(distRoot, 'resources', 'app.asar');
const logsDir = path.join(distRoot, 'logs');

if (!fs.existsSync(distRoot)) {
  console.error('[check-packaged-workers] dist/win-unpacked 不存在，请先 npm run build:dir');
  process.exit(1);
}

const workers = getWorkerEntries(runtimeRoot);

async function probe(name, entry) {
  return new Promise((resolve) => {
    const child = fork(entry, [], {
      cwd: distRoot,
      env: {
        ...process.env,
        QIANFAN_SKIP_LICENSE_CHECK: '1',
        QIANFAN_WORKER_NAME: name,
        QIANFAN_RUNTIME_MODE: 'distributed',
        QIANFAN_APP_ROOT: distRoot,
        QIANFAN_RUNTIME_ROOT: runtimeRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve({ name, ok: true, note: 'running' });
    }, 4000);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ name, ok: code === 0, code, stderr: stderr.trim() });
    });
  });
}

(async () => {
  fs.mkdirSync(logsDir, { recursive: true });
  console.log('[check-packaged-workers] runtimeRoot:', runtimeRoot);
  let failed = 0;
  for (const name of START_ORDER) {
    const entry = workers[name];
    const result = await probe(name, entry);
    console.log(result);
    if (!result.ok) failed += 1;
  }
  if (failed) process.exit(1);
})();
