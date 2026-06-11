#!/usr/bin/env node
const http = require('http');
const {
  acquireDoudianLiveLock,
  registerDoudianLiveLockCleanup,
  getDoudianLiveLockPath,
} = require('../src/platforms/doudian/doudian-run-lock');

const lockPath = process.env.DOUDIAN_TEST_LOCK_PATH || getDoudianLiveLockPath();
const port = Number(process.env.DOUDIAN_TEST_LOCK_PORT || 19640);
const holdPort = process.env.DOUDIAN_TEST_HOLD_PORT === '1';

const result = acquireDoudianLiveLock({
  command: 'doudian:test-run-lock-holder',
  port,
  lockPath,
  forceKill: process.argv.includes('--force-kill'),
});

if (!result.acquired) {
  console.log(JSON.stringify({ acquired: false, reason: result.reason, existingTask: result.existingTask }));
  process.exit(2);
}

registerDoudianLiveLockCleanup(lockPath);

function start() {
  console.log(JSON.stringify({ acquired: true, pid: process.pid, lockPath, holdPort }));
  setInterval(() => {}, 60_000);
}

if (holdPort) {
  const server = http.createServer((_req, res) => res.end('holder'));
  server.listen(port, '127.0.0.1', () => start());
} else {
  start();
}
