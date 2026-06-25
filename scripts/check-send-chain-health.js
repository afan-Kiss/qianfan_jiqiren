const assert = require('assert');
const { computeRuntimeHealth } = require('../src/shared/runtime-health');
const { runCheckScript } = require('./test-utils/cleanup-runtime');

function snapshotWithSendChain(sendChain, overrides = {}) {
  const now = Date.now();
  return {
    supervisorStatus: 'running',
    qianfanReady: true,
    listenerReady: true,
    sendChainReady: sendChain.ok === true,
    sendChain,
    wechatReady: true,
    lastWatchdogFeedAt: now - 5000,
    workers: [
      {
        workerName: 'qianfan-listener',
        status: 'running',
        qianfanReady: true,
        listenerReady: true,
        sendChainReady: sendChain.ok === true,
        sendChain,
        phase: 'running',
        lastHeartbeatAt: now,
      },
      {
        workerName: 'wechat-callback',
        status: 'running',
        hookConnected: true,
        businessReady: true,
        lastHeartbeatAt: now,
      },
      {
        workerName: 'wechat-notifier',
        status: 'running',
        lastHeartbeatAt: now,
      },
      {
        workerName: 'qianfan-sender',
        status: 'running',
        lastHeartbeatAt: now,
      },
      {
        workerName: 'wechat-reply',
        status: 'running',
        lastHeartbeatAt: now,
      },
    ],
    ...overrides,
  };
}

async function main() {
  const now = Date.now();
  const readyChain = {
    ok: true,
    sendChainReady: true,
    shops: [
      { shopTitle: '祥钰珠宝', cdpReady: true, wsOpen: true, wsCount: 2, wsTotal: 2 },
    ],
    summary: { total: 1, cdpReadyCount: 1, wsReadyCount: 1, blockedShops: [] },
    checkedAt: now,
  };

  let health = computeRuntimeHealth(snapshotWithSendChain(readyChain), { notifyAccountCount: 1, now });
  assert.strictEqual(health.sendChainReady, true);
  assert.strictEqual(health.overall.overallStatus, 'normal');
  assert.match(health.sections.qianfan.label, /可发送/);

  const blockedChain = {
    ok: false,
    sendChainReady: false,
    shops: [
      { shopTitle: '祥钰珠宝', cdpReady: true, wsOpen: false, wsCount: 0, wsTotal: 0, reconnecting: false },
    ],
    summary: { total: 1, cdpReadyCount: 1, wsReadyCount: 0, blockedShops: ['祥钰珠宝'] },
    checkedAt: now,
  };

  health = computeRuntimeHealth(snapshotWithSendChain(blockedChain), { notifyAccountCount: 1, now });
  assert.strictEqual(health.sendChainReady, false);
  assert.strictEqual(health.qianfanStatus, 'warning');
  assert.notStrictEqual(health.overall.overallStatus, 'normal');
  assert.match(health.sections.qianfan.label, /祥钰珠宝/);

  console.log('check-send-chain-health: ok');
}

runCheckScript(main);
