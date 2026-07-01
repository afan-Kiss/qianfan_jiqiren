#!/usr/bin/env node
/**
 * 千帆纯协议 IM CLI：监听 + 发送 + 拉历史 + 全量会话消息
 *
 * 示例：
 *   node scripts/run-qianfan-protocol-im.js --shop 祥钰珠宝 status
 *   node scripts/run-qianfan-protocol-im.js --shop 祥钰珠宝 sessions
 *   node scripts/run-qianfan-protocol-im.js --shop 祥钰珠宝 history --buyer 饭饭
 *   node scripts/run-qianfan-protocol-im.js --shop 祥钰珠宝 history-all --include-messages
 *   node scripts/run-qianfan-protocol-im.js --shop 祥钰珠宝 listen --listen-ms 60000
 *   node scripts/run-qianfan-protocol-im.js --shop 祥钰珠宝 send --text "纯协议测试" --really-send
 */
const { getProtocolImService } = require('../src/protocol/qianfan-protocol-service');
const { writeProtocolReport } = require('../src/protocol/qianfan-protocol-report');

function parseArgs(argv) {
  const out = {
    shop: '祥钰珠宝',
    command: 'status',
    buyer: '饭饭',
    appCid: '',
    text: '纯协议 IM 测试',
    listenMs: 30000,
    reallySend: false,
    includeMessages: false,
    maxPages: 10,
    allPages: true,
    help: false,
  };
  const positional = [];
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--shop') out.shop = String(argv[++i] || '').trim();
    else if (a === '--buyer') out.buyer = String(argv[++i] || '').trim();
    else if (a === '--app-cid') out.appCid = String(argv[++i] || '').trim();
    else if (a === '--text') out.text = String(argv[++i] || '').trim();
    else if (a === '--listen-ms') out.listenMs = Number(argv[++i]) || 30000;
    else if (a === '--max-pages') out.maxPages = Number(argv[++i]) || 10;
    else if (a === '--really-send') out.reallySend = true;
    else if (a === '--include-messages') out.includeMessages = true;
    else if (a === '--single-page') out.allPages = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('-')) positional.push(a);
  }
  if (positional[0]) out.command = positional[0];
  return out;
}

function printHelp() {
  console.log(`用法: node scripts/run-qianfan-protocol-im.js [options] <command>

命令:
  status         服务/bridge/配置探针状态
  sessions       列出 snapshot 发现的会话 appCid
  history        拉单会话历史（默认 --buyer 饭饭 或 --app-cid）
  history-all    拉全部会话消息（--include-messages 输出正文）
  listen         启动 WS 监听（bridge 优先，否则 node WS）
  send           发送文字（默认 dry-run，--really-send 仅饭饭）

选项:
  --shop         店铺名称
  --buyer        买家昵称
  --app-cid      会话 appCid
  --text         发送文案
  --listen-ms    listen 命令时长
  --max-pages    history-all 每会话最大分页
  --include-messages  history-all 返回完整 messages
  --single-page  history 只拉一页
  --really-send  真发（白名单买家）
`);
}

async function runCommand(svc, args) {
  switch (args.command) {
    case 'status': {
      const status = svc.getStatus();
      console.log(JSON.stringify(status, null, 2));
      return { ok: true, status };
    }
    case 'sessions': {
      const sessions = svc.listSessions();
      console.log(JSON.stringify(sessions, null, 2));
      return { ok: true, sessionCount: sessions.length, sessions };
    }
    case 'history': {
      const result = await svc.pullSessionHistory(args.appCid, {
        buyerNick: args.buyer,
        allPages: args.allPages,
        maxPages: args.maxPages,
      });
      console.log(
        `[im:history] ok=${result.ok} appCid=${result.appCid || result.session?.appCid} messages=${result.messages?.length || result.messageCount || 0}`
      );
      if (result.messages?.length) {
        for (const m of result.messages.slice(-20)) {
          const side = m.isSellerSide ? '卖家' : '买家';
          console.log(`  [${side}] ${m.buyerNick || ''} ${String(m.text || '').slice(0, 100)} msgId=${m.msgId}`);
        }
      } else {
        console.log(JSON.stringify(result.messagesPreview || [], null, 2));
      }
      return result;
    }
    case 'history-all': {
      const result = await svc.pullAllSessionsMessages({
        includeMessages: args.includeMessages,
        maxPagesPerSession: args.maxPages,
        concurrency: 2,
        delayMs: 150,
      });
      console.log(
        `[im:history-all] ok=${result.ok} sessions=${result.sessionCount} totalMessages=${result.totalMessages}`
      );
      for (const row of result.sessions || []) {
        console.log(
          `  appCid=${String(row.appCid || '').slice(0, 48)}... buyer=${row.buyerNick || '-'} count=${row.messageCount} ok=${row.ok}`
        );
      }
      return result;
    }
    case 'listen': {
      const frames = [];
      const buyerMsgs = [];
      const started = await svc.startListen({
        onFrame: (parsed) => {
          frames.push(parsed?.header?.action || '(frame)');
        },
        onBuyerMessage: (msg) => {
          buyerMsgs.push(msg);
          console.log(`[im:listen] 买家消息 ${msg.buyerNick}: ${String(msg.text || '').slice(0, 120)}`);
        },
      });
      console.log('[im:listen] started', started);
      await new Promise((r) => setTimeout(r, Math.max(1000, args.listenMs)));
      svc.stopListen();
      return { ok: true, started, frameCount: frames.length, buyerMessageCount: buyerMsgs.length, buyerMsgs };
    }
    case 'send': {
      const result = await svc.sendText({
        appCid: args.appCid,
        buyerNick: args.buyer,
        text: args.text,
        reallySend: args.reallySend,
      });
      console.log('[im:send]', JSON.stringify({
        ok: result.ok,
        dryRun: result.dryRun,
        relayUsed: result.relayUsed,
        msgId: result.ack?.msgId,
        error: result.error || result.relayError,
      }, null, 2));
      return result;
    }
    default:
      throw new Error(`未知命令: ${args.command}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log(`[im] shop=${args.shop} command=${args.command}`);
  const svc = await getProtocolImService(args.shop, { buyerNick: args.buyer, noCache: true });
  const init = svc.getStatus();
  console.log('[im] init', { source: init.probe?.shopTitle, sessions: init.sessionCount, bridge: init.bridge });

  const result = await runCommand(svc, args);
  svc.stopListen();

  writeProtocolReport({
    testName: `protocol-im-${args.command}`,
    shopTitle: args.shop,
    command: args.command,
    args,
    init,
    result,
  });

  if (result.ok === false) process.exit(2);
}

main().catch((err) => {
  console.error('[im] FAILED', err.message || err);
  process.exit(1);
});
