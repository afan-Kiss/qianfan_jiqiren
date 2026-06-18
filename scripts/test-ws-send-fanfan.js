#!/usr/bin/env node
/**
 * 测试：连接千帆 WS 桥，向「饭饭」买家 WS 发一条消息
 *
 * 用法:
 *   node scripts/test-ws-send-fanfan.js
 *   node scripts/test-ws-send-fanfan.js --shop "和田雅玉" --text "【WS测试】"
 */
const CDP = require('chrome-remote-interface');
const config = require('../src/wechat/wxbot-new-config');
const { fetchDevToolsJsonList, getPageTargets } = require('../src/devtools-list');
const { detectQianfanShopPages } = require('../src/page-finder');
const { cdpRuntimeEvaluate, cdpPageEnable, cdpNetworkEnable } = require('../src/cdp-timeout');
const { installUiSyncBridge } = require('../src/qianfan-ui-sync');
const { extractMessagesFromResponse } = require('../src/chat-parse');
const {
  getReceiverAppUids,
  extractReceiverAppUidsFromMessage,
} = require('../src/qianfan-data-store');
const {
  registerQianfanWsBridge,
  sendQianfanTextReply,
  fetchMessageListForAppCid,
  findBridgeByShopTitle,
  normalizeShopKey,
} = require('../src/qianfan-ws-bridge');

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const out = {
    shop: '和田雅玉',
    buyer: '饭饭',
    text: '【WS连接测试】请忽略',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--shop' || a === '-s') out.shop = String(argv[++i] || '').trim();
    else if (a === '--buyer' || a === '-b') out.buyer = String(argv[++i] || '').trim();
    else if (a === '--text' || a === '-t') out.text = String(argv[++i] || '').trim();
  }
  return out;
}

async function wakePageWsAfterHook(client, buyerNick) {
  const result = await cdpRuntimeEvaluate(
    client.Runtime,
    {
      expression: `(async function(){
        if (!window.__qfUiSync) return { ok: false, reason: 'no_ui_sync' };
        var nick = ${JSON.stringify(buyerNick)};
        var items = Array.from(document.querySelectorAll('.chat-item, [class*="chat-item"]'));
        var target = null;
        var other = null;
        for (var i = 0; i < items.length; i++) {
          var t = String(items[i].textContent || '').replace(/\\s+/g, ' ').trim();
          if (!t) continue;
          if (t.indexOf(nick) === 0) target = items[i];
          else if (!other) other = items[i];
        }
        if (other) {
          other.click();
          await new Promise(function(r){ setTimeout(r, 900); });
        }
        if (target) {
          target.click();
          await new Promise(function(r){ setTimeout(r, 1200); });
        }
        if (window.__qfRehookImpaasSockets) window.__qfRehookImpaasSockets();
        var list = (window.__qfImpaasSockets || []).filter(function(w){ return w && w.readyState === 1; });
        return { ok: list.length > 0, open: list.length, urls: list.map(function(w){ return String(w.url||''); }).slice(0,3) };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    },
    20000
  );
  return result?.result?.value || { ok: false };
}

async function readPageWsState(client) {
  const result = await cdpRuntimeEvaluate(client.Runtime, {
    expression: `(function(){
      if (window.__qfRehookImpaasSockets) window.__qfRehookImpaasSockets();
      var list = window.__qfImpaasSockets || [];
      return {
        total: list.length,
        open: list.filter(function(w){ return w && w.readyState === 1; }).length,
      };
    })()`,
    returnByValue: true,
  });
  return result?.result?.value || { total: 0, open: 0 };
}

async function extractAppCid(client, buyerNick) {
  const result = await cdpRuntimeEvaluate(
    client.Runtime,
    {
      expression: `(function(){
        var nick = ${JSON.stringify(buyerNick)};
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

async function waitForMessageListTemplate(bridge, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (bridge.lastMessageListRequest?.url) return true;
    await wait(400);
  }
  return false;
}

function deriveReceiverUidsFromAppCid(appCid) {
  const cid = String(appCid || '').trim();
  if (!cid) return [];
  const parts = cid.split(/[\.\$]+/).filter(Boolean);
  for (const part of parts) {
    try {
      const decoded = Buffer.from(part, 'base64').toString('utf8').trim();
      if (/^1#\d+#\d+#/.test(decoded)) return [decoded];
    } catch {
      // ignore
    }
  }
  return [];
}

async function resolveReceiverUids(bridge, shopKey, appCid, buyerNick) {
  const cached = getReceiverAppUids(shopKey, appCid);
  if (cached.length) return { receiverAppUids: cached, source: 'cache' };

  const derived = deriveReceiverUidsFromAppCid(appCid);
  if (derived.length) return { receiverAppUids: derived, source: 'app_cid_decode' };

  const hasTpl = await waitForMessageListTemplate(bridge);
  if (!hasTpl) {
    return { receiverAppUids: [], source: 'no_template' };
  }

  const fetched = await fetchMessageListForAppCid(bridge, appCid);
  if (!fetched.ok) {
    return { receiverAppUids: [], source: 'fetch_fail' };
  }

  const messages = extractMessagesFromResponse(fetched.body, shopKey);
  const hit =
    messages.find((m) => String(m.buyerNick || '').includes(buyerNick)) ||
    messages.filter((m) => String(m.senderType || '').toUpperCase() === 'CUSTOMER').pop() ||
    messages[messages.length - 1];
  const receiverAppUids = hit ? extractReceiverAppUidsFromMessage(hit) : [];
  return { receiverAppUids, source: hit ? 'http_list' : 'empty_list', hit };
}

async function main() {
  const args = parseArgs(process.argv);
  const port = config.qianfanDebug?.devtoolsPort || 9322;
  const host = config.qianfanDebug?.devtoolsHost || '127.0.0.1';
  const shopKey = normalizeShopKey(args.shop);

  console.log('[test-ws-fanfan] 参数:', args);
  console.log('[test-ws-fanfan] DevTools:', `${host}:${port}`);

  const list = await fetchDevToolsJsonList(port, host);
  const page = detectQianfanShopPages(getPageTargets(list)).shops.find(
    (s) => s.shopTitle.includes(args.shop) || args.shop.includes(s.shopTitle)
  );
  if (!page?.webSocketDebuggerUrl) {
    console.error('[test-ws-fanfan] 未找到店铺页:', args.shop);
    process.exit(1);
  }

  console.log('[test-ws-fanfan] 连接店铺:', page.shopTitle);
  const client = await CDP({ target: page.webSocketDebuggerUrl });
  await client.Runtime.enable();
  await cdpPageEnable(client.Page);
  await cdpNetworkEnable(client.Network);

  const bridge = await registerQianfanWsBridge(page, client);
  if (!bridge) {
    console.error('[test-ws-fanfan] registerQianfanWsBridge 失败');
    process.exit(1);
  }

  console.log('[test-ws-fanfan] 等待 hook 生效…');
  await wait(1500);

  await installUiSyncBridge(client);
  console.log('[test-ws-fanfan] 切换会话以在 hook 后重建 WS…');
  const wsWake = await wakePageWsAfterHook(client, args.buyer);
  console.log('[test-ws-fanfan] 会话切换 / WS:', wsWake);
  const pageWs = await readPageWsState(client);
  console.log('[test-ws-fanfan] 页面 WS:', pageWs, 'cdp wsSessions:', bridge.wsSessions?.size || 0);

  const appCid = await extractAppCid(client, args.buyer);
  console.log('[test-ws-fanfan] appCid:', appCid || '(空)');
  if (!appCid) {
    console.error('[test-ws-fanfan] 无法解析 appCid，请确认左侧有「饭饭」会话');
    await client.close();
    process.exit(1);
  }

  const resolved = await resolveReceiverUids(bridge, shopKey, appCid, args.buyer);
  console.log('[test-ws-fanfan] receiver 解析:', {
    source: resolved.source,
    receiverAppUids: resolved.receiverAppUids,
    buyerNick: resolved.hit?.buyerNick,
  });

  if (!resolved.receiverAppUids.length) {
    console.error('[test-ws-fanfan] 无法解析 receiverAppUids，请让饭饭先发一条消息后再试');
    await client.close();
    process.exit(1);
  }

  console.log('[test-ws-fanfan] 开始 WS 发送…');
  try {
    const ack = await sendQianfanTextReply({
      shopTitle: page.shopTitle,
      appCid,
      receiverAppUids: resolved.receiverAppUids,
      text: args.text,
      buyerNick: args.buyer,
    });
    console.log('[test-ws-fanfan] ✅ 发送成功:', {
      msgId: ack.msgId,
      ackConfirmed: ack.ackConfirmed,
      ackSource: ack.ackSource,
      echoVerified: ack.echoVerified,
    });
    await client.close();
    process.exit(0);
  } catch (err) {
    console.error('[test-ws-fanfan] ❌ 发送失败:', err.message || err);
    const b = findBridgeByShopTitle(page.shopTitle);
    console.log('[test-ws-fanfan] bridge:', {
      wsSessions: b?.wsSessions?.size || 0,
      lastManual: b?.lastManualSendAny
        ? {
            requestId: b.lastManualSendAny.requestId,
            appCid: b.lastManualSendAny.appCid,
          }
        : null,
    });
    await client.close();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[test-ws-fanfan] 异常:', err.message || err);
  process.exit(1);
});
