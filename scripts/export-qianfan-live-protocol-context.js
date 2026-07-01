#!/usr/bin/env node
/**
 * 从运行中千帆 Bridge 导出纯协议 local 配置，并可触发旁路测试
 */
const { spawnSync } = require('child_process');
const {
  listLiveProtocolShops,
  loadLiveSnapshot,
  buildLiveProtocolConfig,
  mergeShopIntoLocal,
  saveLocalProtocolConfig,
  writeLiveExportReport,
  printNextSteps,
  getLiveApiBaseUrl,
  getGitCommit,
} = require('../src/protocol/qianfan-live-context-extractor');

function parseArgs(argv) {
  const out = {
    list: false,
    shop: '',
    buyer: '饭饭',
    appCid: '',
    receiverAppUids: [],
    writeLocal: false,
    force: false,
    runProbe: false,
    runListen: false,
    runList: false,
    runTextDry: false,
    listenMs: 30000,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--shop' || a === '-s') out.shop = String(argv[++i] || '').trim();
    else if (a === '--buyer') out.buyer = String(argv[++i] || '饭饭').trim();
    else if (a === '--app-cid') out.appCid = String(argv[++i] || '').trim();
    else if (a === '--receiver-app-uid') out.receiverAppUids.push(String(argv[++i] || '').trim());
    else if (a === '--write-local') out.writeLocal = true;
    else if (a === '--force') out.force = true;
    else if (a === '--run-probe') out.runProbe = true;
    else if (a === '--run-listen') out.runListen = true;
    else if (a === '--run-list') out.runList = true;
    else if (a === '--run-text-dry') out.runTextDry = true;
    else if (a === '--listen-ms') out.listenMs = Number(argv[++i]) || 30000;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  out.receiverAppUids = out.receiverAppUids.filter(Boolean);
  return out;
}

function printHelp() {
  console.log('用法: npm run qf:protocol:export-live -- [options]');
  console.log('  --list');
  console.log('  --shop "店铺名"');
  console.log('  --buyer "饭饭"');
  console.log('  --app-cid "xxx"');
  console.log('  --receiver-app-uid "uid"   可重复');
  console.log('  --write-local');
  console.log('  --force');
  console.log('  --run-probe --run-listen --run-list --run-text-dry');
  console.log('  --listen-ms 30000');
}

function runNpmScript(scriptName, extraArgs = []) {
  const res = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', scriptName, '--', ...extraArgs], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return { ok: res.status === 0, status: res.status ?? 1 };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.list) {
    const listed = await listLiveProtocolShops();
    console.log(`[export-live] mode=${listed.mode} api=${getLiveApiBaseUrl()}`);
    if (!listed.ok) {
      console.error('[export-live] 无法读取 live bridge:', listed.error || 'unavailable');
      console.error('请确认千帆机器人已启动且本地 API 可用。');
      process.exit(1);
    }
    console.log(`[export-live] 已注册店铺数: ${listed.shops.length}`);
    for (const row of listed.shops) {
      console.log('\n---', row.shopTitle, '---');
      console.log('cdpReady:', row.cdpReady, 'wsCandidates:', row.wsCandidateCount);
      console.log('httpTemplates:', row.httpTemplateCount, 'messageList:', row.hasMessageList);
      console.log('wsHandshake:', row.hasWsHandshake);
      console.log('cookie length:', row.cookieSummary?.length, 'keys:', (row.cookieSummary?.keysPreview || []).join(', '));
      console.log('a1:', row.cookieSummary?.hasA1, 'access-token:', row.cookieSummary?.hasAccessToken);
    }
    process.exit(0);
  }

  if (!args.shop) {
    printHelp();
    process.exit(1);
  }

  const loaded = await loadLiveSnapshot(args.shop);
  if (!loaded.ok || !loaded.snapshot?.ok) {
    const err = loaded.error || loaded.snapshot?.error || 'bridge_not_found';
    console.error(`[export-live] 读取 snapshot 失败: ${err}`);
    if (err === 'bridge_not_found') console.error('请确认店铺页已打开且 Bridge 已注册。');
    if (err === 'diagnostic_api_unavailable' || err === 'process_memory_unreachable') {
      console.error('请确认机器人进程已启动（本地 API 127.0.0.1）。');
    }
    process.exit(1);
  }

  const built = buildLiveProtocolConfig(loaded.snapshot, {
    shopTitle: args.shop,
    buyerNick: args.buyer,
    appCid: args.appCid,
    receiverAppUids: args.receiverAppUids,
  });

  const { config, meta } = built;
  console.log('\n=== Live 协议上下文 ===');
  console.log('店铺:', config.shopTitle);
  console.log('mode:', loaded.mode);
  console.log('Cookie 长度:', meta.cookieSummary.length, 'a1:', meta.cookieSummary.hasA1);
  console.log('ws.url:', config.ws.url || '(未找到)');
  console.log('ws handshake:', meta.hasWsHandshakeHeaders ? 'yes' : 'no');
  console.log('messageList:', config.httpTemplates.messageList.url || '(未找到)');
  console.log('appCid:', config.testTarget.appCid || '(未找到)', 'source:', meta.appCidSource);
  console.log(
    'receiverAppUids:',
    config.testTarget.receiverAppUids.length ? config.testTarget.receiverAppUids.join(', ') : '(未找到)',
    'source:',
    meta.receiverAppUidsSource
  );
  console.log('textSendPayload:', meta.textSendPayloadSource || 'missing');
  console.log('imageSendPayload:', meta.imageSendPayloadSource || 'missing');
  if (meta.missingFields.length) console.log('缺失:', meta.missingFields.join(', '));

  let localPath = '';
  let writtenFields = [];
  if (args.writeLocal) {
    const { readExistingLocalConfig } = require('../src/protocol/qianfan-live-context-extractor');
    const existing = readExistingLocalConfig();
    const merged = mergeShopIntoLocal(existing, config, config.shopTitle, args.force);
    localPath = saveLocalProtocolConfig(merged.shops);
    writtenFields = merged.writtenFields;
    console.log('\n[export-live] 已写入', localPath);
    console.log('写入字段:', writtenFields.join(', ') || '(无更新)');
  } else {
    console.log('\n[export-live] 未写入 local（加 --write-local 生效）');
  }

  const report = {
    generatedAt: new Date().toISOString(),
    gitCommit: getGitCommit(),
    nodeVersion: process.version,
    mode: loaded.mode,
    apiBase: getLiveApiBaseUrl(),
    shopTitle: config.shopTitle,
    bridgeExists: loaded.snapshot.ok,
    cdpReady: loaded.snapshot.cdpReady,
    cookieSummary: meta.cookieSummary,
    wsCandidateCount: loaded.snapshot.wsCandidates?.length || 0,
    selectedWsUrl: config.ws.url,
    wsSelectionReason: meta.wsSelectionReason,
    hasWsHandshakeHeaders: meta.hasWsHandshakeHeaders,
    httpTemplateCount: Object.keys(loaded.snapshot.httpTemplates || {}).length,
    hasMessageListTemplate: Boolean(config.httpTemplates.messageList.url),
    appCidSource: meta.appCidSource,
    receiverAppUidsSource: meta.receiverAppUidsSource,
    hasTextSendPayload: Boolean(meta.textSendPayloadSource),
    hasImageSendPayload: Boolean(meta.imageSendPayloadSource),
    writtenLocal: args.writeLocal,
    writtenFields,
    localConfigPath: localPath || '(not written)',
    missingFields: meta.missingFields,
    recentWsHeartbeatFrames: meta.recentWsHeartbeatFrames,
    nextCommands: [
      'npm run qf:protocol:probe',
      `npm run qf:protocol:listen -- --shop "${config.shopTitle}" --listen-ms 30000`,
      `npm run qf:protocol:list -- --shop "${config.shopTitle}"`,
      `npm run qf:protocol:send-text -- --shop "${config.shopTitle}"`,
    ],
  };

  const reportPath = writeLiveExportReport(report);
  console.log('[export-live] 报告:', reportPath);
  printNextSteps(config.shopTitle);

  const testResults = {};
  if (args.writeLocal) {
    if (args.runProbe) testResults.probe = runNpmScript('qf:protocol:probe');
    if (args.runListen) {
      testResults.listen = runNpmScript('qf:protocol:listen', [
        '--shop',
        config.shopTitle,
        '--listen-ms',
        String(args.listenMs),
      ]);
    }
    if (args.runList) testResults.list = runNpmScript('qf:protocol:list', ['--shop', config.shopTitle]);
    if (args.runTextDry) testResults.textDry = runNpmScript('qf:protocol:send-text', ['--shop', config.shopTitle]);
  }

  if (Object.keys(testResults).length) {
    console.log('\n[export-live] 触发测试结果:', testResults);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[export-live] FAILED', err.message || err);
  process.exit(1);
});
