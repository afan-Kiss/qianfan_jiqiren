const fs = require('fs');
const os = require('os');
const path = require('path');

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function resetModules() {
  const keys = [
    '../src/qianfan-data-store.js',
    '../src/wechat-reply-parser.js',
    '../src/wechat-to-qianfan-reply.js',
    '../src/shared/app-root.js',
  ];
  for (const k of keys) {
    delete require.cache[require.resolve(k)];
  }
}

function withTempDataDir(fn) {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qianfan-reply-lock-'));
  process.env.QIANFAN_SIM_DATA_DIR = testDir;
  resetModules();
  const cfg = require('../src/wechat/wxbot-new-config');
  cfg.isAuthorizedReplyWxid = (wxid) => wxid === 'wxid_momo';
  try {
    return fn(testDir);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
    delete process.env.QIANFAN_SIM_DATA_DIR;
    resetModules();
  }
}

function writeSentMap(testDir, map) {
  fs.writeFileSync(path.join(testDir, 'sent-notification-map.json'), `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}

function writePending(testDir, list) {
  fs.writeFileSync(path.join(testDir, 'pending-notifications.json'), `${JSON.stringify(list, null, 2)}\n`, 'utf8');
}

function main() {
  withTempDataDir((testDir) => {
    const {
      lookupSentNotificationForQuote,
      recordSentNotification,
    } = require('../src/qianfan-data-store');
    const { parseAuthorizedWechatReply } = require('../src/wechat-reply-parser');
    const { assertPendingMatchesReply } = require('../src/wechat-to-qianfan-reply');

    const momoWxid = 'wxid_momo';
    const otherWxid = 'wxid_other';
    const momoAppCid = 'appcid-momo-001';
    const otherAppCid = 'appcid-other-002';
    const momoWxMsgId = 'wx-notify-momo-1001';
    const otherWxMsgId = 'wx-notify-other-1002';

    recordSentNotification({
      wxMsgId: momoWxMsgId,
      replyId: 2001,
      shopTitle: '祥钰珠宝',
      appCid: momoAppCid,
      buyerNick: 'momo',
      targetWxid: momoWxid,
      sentAt: Date.now(),
    });
    recordSentNotification({
      wxMsgId: otherWxMsgId,
      replyId: 2002,
      shopTitle: '祥钰珠宝',
      appCid: otherAppCid,
      buyerNick: '多放芝麻少放唐女士',
      targetWxid: otherWxid,
      sentAt: Date.now(),
    });

    writePending(testDir, [
      {
        replyId: 2001,
        shopTitle: '祥钰珠宝',
        buyerNick: 'momo',
        appCid: momoAppCid,
        receiverAppUids: ['uid-momo#2#2#'],
        status: 'notified',
      },
      {
        replyId: 2002,
        shopTitle: '祥钰珠宝',
        buyerNick: '多放芝麻少放唐女士',
        appCid: otherAppCid,
        receiverAppUids: ['uid-other#2#2#'],
        status: 'notified',
      },
    ]);

    const { findPendingByReplyId } = require('../src/qianfan-data-store');

    // a. 正确引用通知 → 通过
    const momoMapped = lookupSentNotificationForQuote(momoWxMsgId, momoWxid);
    assert(momoMapped?.replyId === 2001, 'a: momo quote should map to #2001');
    const momoPending = findPendingByReplyId(2001);
    const momoReply = {
      replyId: 2001,
      quotedWxMsgId: momoWxMsgId,
      quoteText: '【千帆待回复 #2001】\n店铺：祥钰珠宝\n买家：momo',
      source: 'quote',
      mappedReplyId: 2001,
    };
    const momoCheck = assertPendingMatchesReply(momoReply, momoPending, momoWxid);
    assert(momoCheck.ok, 'a: valid momo quote should pass target lock');

    const momoParsed = parseAuthorizedWechatReply(
      { from: momoWxid, wxMsgId: 'wx-reply-1', rawText: '你好' },
      {
        data: {
          msg: '你好',
          refermsg: {
            msgid: momoWxMsgId,
            content: '【千帆待回复 #2001】\n店铺：祥钰珠宝\n买家：momo',
          },
        },
      }
    );
    assert(momoParsed.ok && momoParsed.replyId === 2001, 'a: parser should accept valid momo quote');

    // b. 引用 A 通知但文本里出现 B 编号 → 拦截
    const conflictParsed = parseAuthorizedWechatReply(
      { from: momoWxid, wxMsgId: 'wx-reply-2', rawText: '你好' },
      {
        data: {
          msg: '你好',
          refermsg: {
            msgid: momoWxMsgId,
            content: '【千帆待回复 #2002】\n店铺：祥钰珠宝\n买家：多放芝麻少放唐女士',
          },
        },
      }
    );
    assert(!conflictParsed.ok && conflictParsed.reason === 'quote_reply_id_conflict', 'b: quote id conflict must block');

    // c. quotedWxMsgId 映射 targetWxid 不一致 → 拦截
    const crossUserMap = lookupSentNotificationForQuote(momoWxMsgId, otherWxid);
    assert(crossUserMap === null, 'c: cross wxid quote map must return null');
    const crossParsed = parseAuthorizedWechatReply(
      { from: otherWxid, wxMsgId: 'wx-reply-3', rawText: '你好' },
      {
        data: {
          msg: '你好',
          refermsg: {
            msgid: momoWxMsgId,
            content: '【千帆待回复 #2001】\n店铺：祥钰珠宝\n买家：momo',
          },
        },
      }
    );
    assert(!crossParsed.ok, 'c: wrong target wxid must not parse as ok quote');

    // d. pending 缺 appCid → 拦截
    const noCidCheck = assertPendingMatchesReply(
      momoReply,
      { ...momoPending, appCid: '' },
      momoWxid
    );
    assert(!noCidCheck.ok && noCidCheck.blockReason.includes('missing_app_cid'), 'd: missing appCid must block');

    // e. pending 缺 receiverAppUids → 拦截
    const noReceiverCheck = assertPendingMatchesReply(
      momoReply,
      { ...momoPending, receiverAppUids: [] },
      momoWxid
    );
    assert(
      !noReceiverCheck.ok && noReceiverCheck.blockReason.includes('missing_receiver_app_uids'),
      'e: missing receiverAppUids must block'
    );

    // f. momo 和“多放芝麻少放唐女士”同时存在时，回复 momo 通知必须只发送 momo 的 appCid/receiverAppUids
    const momoOnly = assertPendingMatchesReply(momoReply, momoPending, momoWxid);
    assert(
      momoOnly.ok &&
        momoOnly.receiverAppUids.join(',') === 'uid-momo#2#2#' &&
        momoPending.appCid === momoAppCid,
      'f: momo reply must lock to momo appCid/receiverAppUids'
    );
    const wrongPendingCheck = assertPendingMatchesReply(momoReply, findPendingByReplyId(2002), momoWxid);
    assert(
      !wrongPendingCheck.ok &&
        (wrongPendingCheck.blockReason.includes('quoted_reply_id_mismatch') ||
          wrongPendingCheck.blockReason.includes('quote_buyer_mismatch') ||
          wrongPendingCheck.blockReason.includes('quote_reply_id_mismatch')),
      'f: momo quote must not match other buyer pending'
    );
  });

  const src = fs.readFileSync(path.join(__dirname, '../src/wechat-to-qianfan-reply.js'), 'utf8');
  assert(src.includes('strictTarget: true'), 'wechat reply path must call sendQianfanTextReply with strictTarget');
  assert(!src.includes('resolveReplyContextFromBridge'), 'wechat reply path must not resolve context from bridge');
  assert(!src.includes('resolveReplyContextForSend'), 'wechat reply path must not resolve context for send');
  assert(src.includes('[发送前校验]'), 'must log pre-send validation pass');
  assert(src.includes('[发送前拦截]'), 'must log pre-send block');

  console.log('[check-qianfan-reply-target-lock] OK');
}

main();
