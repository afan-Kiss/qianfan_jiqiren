#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');
const { loadProtocolShopConfigs } = require('../src/protocol/qianfan-protocol-config');
const { writeProtocolReport, printProtocolSummary, getGitCommit } = require('../src/protocol/qianfan-protocol-report');
const { parseProtocolArgs, printProtocolHelp } = require('./_protocol-cli');

function runNodeScript(scriptName, extraArgs = []) {
  const scriptPath = path.join(__dirname, scriptName);
  const res = spawnSync(process.execPath, [scriptPath, ...extraArgs], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return {
    script: scriptName,
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

async function main() {
  const args = parseProtocolArgs(process.argv);
  if (args.help || !args.shop) {
    printProtocolHelp('run-qianfan-protocol-all-tests.js', [
      '--shop "店铺名称"',
      '默认不 --really-send',
    ]);
    process.exit(args.help ? 0 : 1);
  }

  const { shops } = loadProtocolShopConfigs();
  const shop = shops.find((s) => s.shopTitle === args.shop);
  if (!shop) {
    console.error(`未找到店铺: ${args.shop}`);
    process.exit(1);
  }

  const common = ['--shop', args.shop];
  const steps = [];

  steps.push(runNodeScript('probe-qianfan-protocol.js'));
  if (shop.ws?.url) {
    steps.push(runNodeScript('test-qianfan-protocol-listen.js', [...common, '--listen-ms', String(args.listenMs || 10000)]));
  }
  if (shop.httpTemplates?.messageList?.url && shop.testTarget?.appCid) {
    steps.push(runNodeScript('test-qianfan-protocol-message-list.js', [...common, '--app-cid', shop.testTarget.appCid]));
  }
  steps.push(runNodeScript('test-qianfan-protocol-send-text.js', common));
  steps.push(runNodeScript('test-qianfan-protocol-send-image.js', common));

  const failed = steps.filter((s) => s.status !== 0);
  const report = writeProtocolReport({
    testName: 'all-tests',
    shopTitle: args.shop,
    gitCommit: getGitCommit(),
    steps: steps.map((s) => ({
      script: s.script,
      status: s.status,
      stderrTail: String(s.stderr || '').slice(-500),
    })),
    allPassed: failed.length === 0,
  });

  for (const s of steps) {
    console.log(`\n===== ${s.script} exit=${s.status} =====`);
    if (s.stdout) console.log(s.stdout);
    if (s.stderr) console.error(s.stderr);
  }

  printProtocolSummary(report);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('[protocol:all] FAILED', err.message || err);
  process.exit(1);
});
