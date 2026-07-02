#!/usr/bin/env node
/** 经本地 API（主进程 bridge）跑 IM 验证 */
const http = require('http');

const BASE = process.env.QIANFAN_LOCAL_API || 'http://127.0.0.1:9323';
const SHOP = process.argv[2] || '祥钰珠宝';

function request(method, path, body) {
  const url = new URL(path, BASE);
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request(
      url,
      {
        method,
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            json = { raw: data };
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const q = encodeURIComponent(SHOP);
  console.log('=== IM API 验证 shop=', SHOP, 'base=', BASE);

  const status = await request('GET', `/api/qianfan/protocol/im/status?shopTitle=${q}`);
  console.log('\n[status]', status.status, JSON.stringify(status.json?.bridge, null, 2));

  const sessions = await request('GET', `/api/qianfan/protocol/im/sessions?shopTitle=${q}`);
  console.log('\n[sessions]', sessions.status, 'count=', sessions.json?.sessions?.length);

  const history = await request('GET', `/api/qianfan/protocol/im/history?shopTitle=${q}&buyerNick=${encodeURIComponent('饭饭')}`);
  console.log('\n[history]', history.status, {
    ok: history.json?.ok,
    source: history.json?.source,
    count: history.json?.messageCount || history.json?.messages?.length,
    error: history.json?.error,
  });
  for (const m of (history.json?.messages || []).slice(-8)) {
    const side = m.isSellerSide ? '卖' : '买';
    console.log(`  [${side}] ${String(m.text || '').slice(0, 80)} msgId=${m.msgId}`);
  }

  const dry = await request('POST', `/api/qianfan/protocol/im/send-text?shopTitle=${q}`, {
    buyerNick: '饭饭',
    text: `纯协议API测试 ${new Date().toISOString().slice(11, 19)}`,
    reallySend: false,
  });
  console.log('\n[send dry-run]', dry.status, { ok: dry.json?.ok, dryRun: dry.json?.dryRun });

  const really = await request('POST', `/api/qianfan/protocol/im/send-text?shopTitle=${q}`, {
    buyerNick: '饭饭',
    text: `纯协议API真发 ${new Date().toISOString().slice(11, 19)}`,
    reallySend: true,
    useRelay: true,
  });
  console.log('\n[send really]', really.status, {
    ok: really.json?.ok,
    relayUsed: really.json?.relayUsed,
    msgId: really.json?.ack?.msgId,
    error: really.json?.error || really.json?.relayError,
    method: really.json?.method,
  });

  if (really.json?.ok) {
    await new Promise((r) => setTimeout(r, 1500));
    const verify = await request('GET', `/api/qianfan/protocol/im/history?shopTitle=${q}&buyerNick=${encodeURIComponent('饭饭')}&allPages=0`);
    const needle = really.json?.built?.payload?.body?.contentInfo?.content || '';
    const hit = (verify.json?.messages || []).find((m) => String(m.text || '').includes('纯协议API真发'));
    console.log('\n[verify list]', { found: Boolean(hit), msgId: hit?.msgId, source: verify.json?.source });
  }

  const all = await request('GET', `/api/qianfan/protocol/im/history/all?shopTitle=${q}&maxPages=2`);
  console.log('\n[history-all]', all.status, {
    ok: all.json?.ok,
    sessions: all.json?.sessionCount,
    totalMessages: all.json?.totalMessages,
  });

  const ok = history.json?.ok && dry.json?.ok;
  process.exit(ok ? 0 : 2);
}

main().catch((err) => {
  console.error('FAILED', err.message || err);
  process.exit(1);
});
