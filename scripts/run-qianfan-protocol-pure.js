#!/usr/bin/env node
/**
 * 纯协议验证：仅 Node WS（auth + listen + send），不用 bridge / CDP / page_ws
 * 配置来源：local + protocol-tap JSONL 刷新 authorization
 */
const { getProtocolImService } = require('../src/protocol/qianfan-protocol-service');
const { writeProtocolReport } = require('../src/protocol/qianfan-protocol-report');

function parseArgs(argv) {
  const out = { shop: '祥钰珠宝', buyer: '饭饭', reallySend: false, listenMs: 8000, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--shop') out.shop = String(argv[++i] || '').trim();
    else if (a === '--buyer') out.buyer = String(argv[++i] || '饭饭').trim();
    else if (a === '--really-send') out.reallySend = true;
    else if (a === '--listen-ms') out.listenMs = Number(argv[++i]) || 8000;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法: node scripts/run-qianfan-protocol-pure.js --shop 祥钰珠宝 [--really-send]');
    process.exit(0);
  }

  console.log(`[pure] shop=${args.shop} 仅 Node WS（auth + listen + send）`);
  const svc = await getProtocolImService(args.shop, { noCache: true, buyerNick: args.buyer });
  const init = await svc.init();
  console.log('[pure] init', { source: init.source, tapApplied: init.tapApplied, sessions: init.sessionCount });

  const status = svc.getStatus();
  console.log('[pure] status', {
    wsListenUrl: status.client.wsListenUrl,
    wsSendUrl: status.client.wsSendUrl,
    canWsSend: status.client.canWsSend,
    wsAuthed: status.client.wsAuthed,
    channelId: status.client.wsChannelId,
    hasAuthSid: Boolean(svc.config?.httpAuthHeaders?.authorization || svc.config?.ws?.authTemplate?.body?.sid),
    hasAuthUid: Boolean(svc.config?.ws?.authTemplate?.body?.uid),
    appCid: svc.config?.testTarget?.appCid?.slice(0, 48),
  });

  const history = await svc.pullSessionHistory('', { buyerNick: args.buyer, listenMs: args.listenMs });
  console.log('[pure] history', {
    ok: history.ok,
    status: history.status,
    source: history.source,
    count: history.messageCount || history.messages?.length,
    error: history.error || history.apiMsg,
  });
  for (const m of (history.messages || []).slice(-5)) {
    const side = m.isSellerSide ? '卖' : '买';
    console.log(`  [${side}] ${String(m.text || '').slice(0, 80)}`);
  }

  const listen = await svc.startListen({
    onBuyerMessage: (msg) => {
      console.log(`[pure:listen] ${msg.buyerNick}: ${String(msg.text || '').slice(0, 80)}`);
    },
  });
  console.log('[pure] listen', listen);
  await new Promise((r) => setTimeout(r, Math.max(2000, args.listenMs)));
  svc.stopListen();

  const text = `纯协议测试 ${new Date().toISOString().slice(11, 19)}`;
  const dry = await svc.sendText({ buyerNick: args.buyer, text, reallySend: false });
  console.log('[pure] send dry-run', { ok: dry.ok, dryRun: dry.dryRun, traceId: dry.traceId });

  let really = { skipped: true };
  if (args.reallySend) {
    really = await svc.sendText({ buyerNick: args.buyer, text, reallySend: true, verifyList: false });
    console.log('[pure] send really', {
      ok: really.ok,
      msgId: really.ack?.msgId,
      error: really.error,
      method: really.method,
    });
    if (really.ok) {
      await new Promise((r) => setTimeout(r, 1200));
      const verify = await svc.pullSessionHistory('', { buyerNick: args.buyer, listenMs: 3000 });
      const hit = (verify.messages || []).find((m) => String(m.text || '').includes('纯协议测试'));
      console.log('[pure] verify', { found: Boolean(hit), msgId: hit?.msgId, ackMsgId: really.ack?.msgId });
    }
  }

  const report = writeProtocolReport({
    testName: 'protocol-pure',
    shopTitle: args.shop,
    init,
    history,
    listen,
    dry,
    really,
    pureOnly: true,
  });

  const ok = dry.ok && (!args.reallySend || really.ok);
  const finalStatus = svc.getStatus();
  if (!finalStatus.client.canWsSend && args.reallySend) {
    console.log('[pure] blocker: 缺少发送 WS（在饭饭会话发一条消息让 tap 捕获 /message/send）');
  }
  if (!finalStatus.client.wsAuthed && String(finalStatus.client.wsListenUrl || '').includes('apppush')) {
    console.log('[pure] blocker: apppush auth 失败（sid 过期），请保持 tap:auto 运行并刷新客服台会话');
  }
  console.log('[pure] report', report.reportPath);
  process.exit(ok ? 0 : 2);
}

main().catch((err) => {
  console.error('[pure] FAILED', err.message || err);
  process.exit(1);
});
