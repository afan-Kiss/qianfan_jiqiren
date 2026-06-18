#!/usr/bin/env node
/**
 * 测试 WS 断线恢复：仅向「饭饭」UI 探针发消息，不向其他买家主动发消息
 *
 * 用法:
 *   node scripts/test-ws-wake-recovery.js --target "干掉彩虹" --text "【WS恢复测试】请忽略"
 *   node scripts/test-ws-wake-recovery.js --simulate-ws-dead --app-cid "..." --receiver-uids "1#2#2#xxx"
 */
const CDP = require('chrome-remote-interface');
const config = require('../src/wechat/wxbot-new-config');
const { fetchDevToolsJsonList, getPageTargets } = require('../src/devtools-list');
const { detectQianfanShopPages } = require('../src/page-finder');
const { cdpRuntimeEvaluate, cdpPageEnable } = require('../src/cdp-timeout');
const { installUiSyncBridge } = require('../src/qianfan-ui-sync');
const { extractMessagesFromResponse } = require('../src/chat-parse');
const { findReceiverCacheForShop, getReceiverAppUids, extractReceiverAppUidsFromMessage } = require('../src/qianfan-data-store');
const {
  registerQianfanWsBridge,
  sendQianfanTextReply,
  resolveReplyContextForSend,
  resolveReplyContextFromBridge,
  findBridgeByShopTitle,
  fetchMessageListForAppCid,
  normalizeShopKey,
} = require('../src/qianfan-ws-bridge');

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const out = {
    shop: '和田雅玉',
    target: '饭饭',
    text: '【WS恢复测试】请忽略',
    simulateWsDead: false,
    appCid: '',
    receiverUids: [],
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--shop' || a === '-s') out.shop = String(argv[++i] || '').trim();
    else if (a === '--target' || a === '-t') out.target = String(argv[++i] || '').trim();
    else if (a === '--text') out.text = String(argv[++i] || '').trim();
    else if (a === '--app-cid') out.appCid = String(argv[++i] || '').trim();
    else if (a === '--receiver-uids') {
      out.receiverUids = String(argv[++i] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--simulate-ws-dead' || a === '--force-ws-dead') out.simulateWsDead = true;
  }
  return out;
}

async function clickBuyerInUi(client, buyerNick) {
  await installUiSyncBridge(client);
  const result = await cdpRuntimeEvaluate(
    client.Runtime,
    {
      expression: `(async function(){
        if (!window.__qfUiSync) return { ok: false, reason: 'no_ui_sync' };
        return await window.__qfUiSync.reselectConversation('', ${JSON.stringify(buyerNick)});
      })()`,
      awaitPromise: true,
      returnByValue: true,
    },
    15000
  );
  return result?.result?.value || { ok: false };
}

async function waitForMessageListTemplate(bridge, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (bridge.lastMessageListRequest?.url) return true;
    await wait(400);
  }
  return false;
}

async function extractAppCidFromActiveChat(client, target) {
  const result = await cdpRuntimeEvaluate(
    client.Runtime,
    {
      expression: `(function(){
        var nick = ${JSON.stringify(target)};
        var active = document.querySelector('.chat-item.active');
        var appCid = active ? (active.getAttribute('data-key') || active.dataset.key || '') : '';
        if (!appCid) {
          var items = document.querySelectorAll('.chat-item');
          for (var i = 0; i < items.length; i++) {
            var t = String(items[i].textContent || '').replace(/\\s+/g, ' ').trim();
            if (t.indexOf(nick) === 0) {
              appCid = items[i].getAttribute('data-key') || items[i].dataset.key || '';
              break;
            }
          }
        }
        return { appCid: appCid };
      })()`,
      returnByValue: true,
    },
    10000
  );
  return String(result?.result?.value?.appCid || '').trim();
}

async function resolveTargetContext(client, bridge, shop, target, cli = {}) {
  const shopKey = normalizeShopKey(shop);

  if (cli.appCid && cli.receiverUids?.length) {
    return {
      shopTitle: shopKey,
      appCid: cli.appCid,
      buyerNick: target,
      receiverAppUids: cli.receiverUids,
      source: 'cli',
    };
  }

  let ctx =
    (await resolveReplyContextForSend(shop, target)) ||
    resolveReplyContextFromBridge(shop, target);

  const cached = findReceiverCacheForShop(shopKey, target);
  if (!ctx && cached?.appCid && cached.receiverAppUids?.length) {
    ctx = { shopTitle: shopKey, appCid: cached.appCid, buyerNick: target, receiverAppUids: cached.receiverAppUids, source: 'cache' };
  }

  if (ctx?.appCid && ctx.receiverAppUids?.length) return ctx;

  console.log('[test-ws-recovery] 本地无缓存，仅 UI 点击目标买家（不发消息）…');
  const clicked = await clickBuyerInUi(client, target);
  console.log('[test-ws-recovery] UI 点击结果:', clicked);
  await wait(1200);

  const appCid = await extractAppCidFromActiveChat(client, target);
  console.log('[test-ws-recovery] 从 data-key 解析 appCid:', appCid || '(空)');

  const hasTpl = await waitForMessageListTemplate(bridge);
  console.log('[test-ws-recovery] messageList 模板:', hasTpl ? bridge.lastMessageListRequest.url.split('?')[0] : '未捕获');

  if (appCid && hasTpl) {
    const fetched = await fetchMessageListForAppCid(bridge, appCid);
    if (fetched.ok) {
      const messages = extractMessagesFromResponse(fetched.body, shopKey);
      const hit =
        messages.find((m) => String(m.buyerNick || '').includes(target) || target.includes(String(m.buyerNick || ''))) ||
        messages.filter((m) => String(m.senderType || '').toUpperCase() === 'CUSTOMER').pop() ||
        messages[messages.length - 1];
      const receiverAppUids = hit ? extractReceiverAppUidsFromMessage(hit) : [];
      const cachedUids = getReceiverAppUids(shopKey, appCid);
      const finalUids = receiverAppUids.length ? receiverAppUids : cachedUids;
      if (finalUids.length) {
        return {
          shopTitle: shopKey,
          appCid,
          buyerNick: hit?.buyerNick || target,
          receiverAppUids: finalUids,
          source: 'http_list',
        };
      }
    }
  }

  if (appCid) {
    const uids = getReceiverAppUids(shopKey, appCid);
    if (uids.length) {
      return { shopTitle: shopKey, appCid, buyerNick: target, receiverAppUids: uids, source: 'app_cid_cache' };
    }
  }

  return null;
}

async function simulateWsSendFailure(client, bridge) {
  await cdpRuntimeEvaluate(
    client.Runtime,
    {
      expression: `(function(){
        window.__qfImpaasSockets = [];
        return { cleared: true };
      })()`,
      returnByValue: true,
    },
    10000
  );
  if (bridge) {
    bridge.wsSessions.clear();
    bridge.wsUrls.clear();
    bridge.lastManualSendAny = null;
    bridge.lastManualSendByAppCid.clear();
  }
  console.log('[test-ws-recovery] 已模拟 WS 不可用（清空 hook 列表 + bridge 缓存，不向任何买家发消息）');
}

async function main() {
  const args = parseArgs(process.argv);
  const port = config.qianfanDebug?.devtoolsPort || 9322;
  const host = config.qianfanDebug?.devtoolsHost || '127.0.0.1';
  const wakeNick = config.qianfanDebug?.wsWakeBuyerNick || '饭饭';

  console.log('[test-ws-recovery] 参数:', args);
  console.log('[test-ws-recovery] 规则：仅「' + wakeNick + '」会收到 UI 探针消息，其他买家不会主动发消息');
  console.log('[test-ws-recovery] ⚠ 会弹出千帆窗口，请看屏幕');

  const list = await fetchDevToolsJsonList(port, host);
  const page = detectQianfanShopPages(getPageTargets(list)).shops.find(
    (s) => s.shopTitle.includes(args.shop) || args.shop.includes(s.shopTitle)
  );
  if (!page?.webSocketDebuggerUrl) {
    console.error('[test-ws-recovery] 未找到店铺页:', args.shop);
    process.exit(1);
  }

  console.log('[test-ws-recovery] 连接', page.shopTitle);
  const client = await CDP({ target: page.webSocketDebuggerUrl });
  await client.Runtime.enable();
  await cdpPageEnable(client.Page);

  const bridge = await registerQianfanWsBridge(page, client);
  if (!bridge) {
    console.error('[test-ws-recovery] registerQianfanWsBridge 失败');
    process.exit(1);
  }

  console.log('[test-ws-recovery] 解析目标买家会话:', args.target);
  const ctx = await resolveTargetContext(client, bridge, args.shop, args.target, {
    appCid: args.appCid,
    receiverUids: args.receiverUids,
  });
  if (!ctx?.appCid || !ctx.receiverAppUids?.length) {
    console.error('[test-ws-recovery] 无法解析买家上下文。请先让机器人跑过该买家消息，或传入:');
    console.error('  --app-cid "..." --receiver-uids "1#2#2#xxx"');
    console.error('[test-ws-recovery] ctx=', ctx);
    await client.close();
    process.exit(1);
  }
  console.log('[test-ws-recovery] 目标上下文:', {
    source: ctx.source,
    shopTitle: ctx.shopTitle,
    buyerNick: ctx.buyerNick,
    appCid: ctx.appCid,
    receiverAppUids: ctx.receiverAppUids,
  });

  if (args.simulateWsDead) {
    await simulateWsSendFailure(client, bridge);
  }

  console.log('[test-ws-recovery] 开始 sendQianfanTextReply');
  console.log('[test-ws-recovery] 若 WS 不可用 → 仅向「' + wakeNick + '」UI 探针 → 捕获 WS → 重试 WS 发给「' + args.target + '」');
  try {
    const ack = await sendQianfanTextReply({
      shopTitle: args.shop,
      appCid: ctx.appCid,
      receiverAppUids: ctx.receiverAppUids,
      text: args.text,
      buyerNick: ctx.buyerNick || args.target,
    });
    console.log('[test-ws-recovery] ✅ 发送成功:', {
      msgId: ack.msgId,
      ackConfirmed: ack.ackConfirmed,
      ackSource: ack.ackSource,
      echoVerified: ack.echoVerified,
    });
    await client.close();
    process.exit(0);
  } catch (err) {
    console.error('[test-ws-recovery] ❌ 发送失败:', err.message || err);
    const b = findBridgeByShopTitle(args.shop);
    console.log('[test-ws-recovery] bridge 状态:', {
      wsSessions: b?.wsSessions?.size || 0,
      lastManual: b?.lastManualSendAny
        ? {
            requestId: b.lastManualSendAny.requestId,
            appCid: b.lastManualSendAny.appCid,
            capturedAt: b.lastManualSendAny.capturedAt,
          }
        : null,
    });
    await client.close();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[test-ws-recovery] 异常:', err.message || err);
  process.exit(1);
});
