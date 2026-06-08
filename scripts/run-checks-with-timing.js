const path = require('path');
const fs = require('fs');
const { runScriptsWithTiming } = require('./test-utils/run-with-timing');

const ROOT = path.resolve(__dirname, '..');
const packageScripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;

const QUICK_CHECKS = [
  'check:runtime',
  'check:workers',
  'check:worker-start-retry',
  'check:qianfan-send-dedup',
  'check:qianfan-runtime',
  'check:start-idempotent',
  'check:ui-log-dedup',
  'check:qianfan-status',
  'check:failure-owner',
  'check:watchdog',
  'check:bus',
  'check:callback',
  'check:failure-receipt',
  'check:restart-state',
  'check:persistence',
  'check:idempotency',
  'check:bus-rpc',
  'check:dead-letter',
  'check:cli-compat',
  'check:notifier-hooks',
  'check:sim-chain',
];

async function main() {
  await runScriptsWithTiming(QUICK_CHECKS, {
    cwd: ROOT,
    rootDir: ROOT,
    packageScripts,
    warnMs: 30000,
  });
}

main().catch((err) => {
  console.error('[check:timed] FAILED');
  console.error(err.message || err);
  process.exit(typeof err.exitCode === 'number' ? err.exitCode : 1);
});
