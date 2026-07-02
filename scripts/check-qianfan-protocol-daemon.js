#!/usr/bin/env node
/**
 * 千帆纯协议守护 — 静态验收 + 可选冒烟
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');

function read(p) {
  return fs.readFileSync(path.join(root, p), 'utf8');
}

function testStatic() {
  assert(fs.existsSync(path.join(root, 'scripts/qianfan-protocol-daemon.js')));
  assert(fs.existsSync(path.join(root, 'scripts/qianfan-protocol-config-agent.js')));
  assert(fs.existsSync(path.join(root, 'src/protocol/qianfan-protocol-daemon-core.js')));
  assert(fs.existsSync(path.join(root, 'src/protocol/qianfan-protocol-daemon-api.js')));
  assert(fs.existsSync(path.join(root, 'ecosystem.config.cjs')));

  const apiSrc = read('src/protocol/qianfan-protocol-daemon-api.js');
  assert(apiSrc.includes('/api/qianfan/protocol/status'));
  assert(apiSrc.includes('/api/qianfan/protocol/reload'));
  assert(apiSrc.includes('/api/qianfan/protocol/config/upload'));

  const coreSrc = read('src/protocol/qianfan-protocol-daemon-core.js');
  assert(coreSrc.includes('MessageDedupStore'));
  assert(coreSrc.includes('markCredentialExpired'));
  assert(coreSrc.includes('pollHttpHistory'));

  const bridgeSrc = read('src/protocol/qianfan-protocol-bridge-server.js');
  assert(bridgeSrc.includes('/health'));
  assert(bridgeSrc.includes('/send'));

  const pkg = JSON.parse(read('package.json'));
  assert(pkg.scripts['qf:protocol:daemon']);
  assert(pkg.scripts['qf:protocol:config-agent']);
  assert(pkg.scripts['qf:protocol:bridge']);

  console.log('[check] static OK');
}

async function testDedup() {
  const { MessageDedupStore, buildMessageDedupKey } = require('../src/protocol/qianfan-protocol-daemon-dedup');
  const store = new MessageDedupStore({
    filePath: path.join(root, 'data', 'tmp-dedup-test.json'),
    maxKeys: 100,
  });
  const msg = { msgId: 'm1', text: 'hello', appCid: 'c1', createAt: 1 };
  const key = buildMessageDedupKey('shop', msg);
  assert(!store.tryConsume('shop', msg).duplicate);
  assert(store.tryConsume('shop', msg).duplicate);
  console.log('[check] dedup OK', key);
}

async function testDaemonStatusShape() {
  const { QianfanProtocolDaemon } = require('../src/protocol/qianfan-protocol-daemon-core');
  const daemon = new QianfanProtocolDaemon({ useTapOnLoad: false });
  const status = daemon.getStatus();
  assert(status.daemonRunning === false);
  assert(Array.isArray(status.recentEvents));
  console.log('[check] daemon status shape OK');
}

async function testCredentialDetection() {
  const { isCredentialError } = require('../src/protocol/qianfan-protocol-daemon-core');
  assert(isCredentialError('user unauthorized!'));
  assert(!isCredentialError('network timeout'));
  console.log('[check] credential detection OK');
}

async function main() {
  testStatic();
  await testDedup();
  await testDaemonStatusShape();
  await testCredentialDetection();
  console.log('[check] qianfan-protocol-daemon checks passed');
}

main().catch((err) => {
  console.error('[check] FAILED', err.message || err);
  process.exit(1);
});
