const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const errors = [];

function check(cond, message) {
  if (!cond) errors.push(message);
}

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

const requiredRuntime = [
  'src/runtime/supervisor.js',
  'src/runtime/watchdog.js',
  'src/runtime/restart-policy.js',
  'src/runtime/worker-runner.js',
  'src/runtime/message-bus.js',
];

for (const rel of requiredRuntime) {
  check(fs.existsSync(path.join(ROOT, rel)), `缺少 ${rel}`);
}

const workerFiles = fs
  .readdirSync(path.join(ROOT, 'src/workers'))
  .filter((name) => name.endsWith('.worker.js'));
check(workerFiles.length >= 6, 'worker 文件数量不足');

const adapterFiles = fs
  .readdirSync(path.join(ROOT, 'src/adapters'))
  .filter((name) => name.startsWith('legacy-') && name.endsWith('.js'));
check(adapterFiles.length >= 6, 'adapter 文件数量不足');

const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
check(pkg.scripts && pkg.scripts['start:cli'], 'package.json 缺少 start:cli');

const ipcBridge = read(path.join(ROOT, 'src/main/ipc-bridge.js'));
check(!ipcBridge.includes('wxbot-new-oneclick.js'), 'Electron 仍直接 spawn wxbot-new-oneclick.js');
check(ipcBridge.includes('RuntimeSupervisor') || ipcBridge.includes('runtimeSupervisor'), 'Electron 未接入 RuntimeSupervisor');

if (errors.length) {
  console.error('[check-runtime-architecture] FAILED');
  for (const err of errors) console.error(`- ${err}`);
  process.exit(1);
}

console.log('[check-runtime-architecture] OK');
