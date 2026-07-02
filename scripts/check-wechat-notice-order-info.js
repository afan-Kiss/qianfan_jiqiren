const assert = require('assert');
const { formatWechatNotice } = require('../src/qianfan-wechat-notifier');
const {
  pickOrderInfoFromMessages,
  formatOrderInfoForNotice,
  collectMessageImageUrls,
  normalizeQianfanMessage,
} = require('../src/chat-parse');

function main() {
  const messages = [
    {
      contentType: 'text',
      text: '这个多少钱',
      orderInfo: {
        orderId: 'P123456789',
        productTitle: '和田玉手镯',
        amount: '¥1280',
        orderDate: '2026-07-01 14:30',
        status: '待发货',
        hasAfterSale: false,
        afterSaleLabel: '无售后',
      },
    },
  ];

  const notice = formatWechatNotice(1001, {
    shopTitle: '祥钰珠宝',
    buyerNick: '饭饭',
    createAt: Date.now(),
    texts: ['这个多少钱'],
    messages,
    orderInfo: pickOrderInfoFromMessages(messages),
  });

  assert.ok(notice.includes('订单号：P123456789'), '通知应包含订单号');
  assert.ok(notice.includes('价格：¥1280'), '通知应包含价格');
  assert.ok(notice.includes('下单：2026-07-01 14:30'), '通知应包含下单时间');
  assert.ok(notice.includes('售后：无售后'), '通知应包含售后状态');

  const orderLines = formatOrderInfoForNotice(messages[0].orderInfo);
  assert.strictEqual(orderLines.length, 6);

  const orderTextMsg = normalizeQianfanMessage({
    shopTitle: '祥钰珠宝',
    appCid: 'cid-1',
    source: 'ws',
    raw: {
      appCid: 'cid-1',
      createAt: Date.now(),
      senderType: 'CUSTOMER',
      senderAppUid: 'buyer#2#2#1',
      contentInfo: {
        contentType: 1,
        content: 'P1234567890123456',
      },
      extension: {
        sender: {
          presentInfo: {
            type: 'CUSTOMER',
            nickName: '饭饭',
            avatar: 'https://sns-avatar-qc.xhscdn.com/avatar/default.jpg',
          },
        },
      },
    },
  });
  assert.strictEqual(orderTextMsg.contentType, 'text');
  assert.strictEqual(orderTextMsg.text, 'P1234567890123456');
  assert.strictEqual(collectMessageImageUrls(orderTextMsg).length, 0, '纯订单号文本不应转发头像');

  const fakeProductMsg = {
    contentType: 'product',
    productInfo: {
      title: '和田玉',
      price: '¥99',
      imageUrl: 'https://sns-avatar-qc.xhscdn.com/avatar/default.jpg',
    },
    imageUrls: ['https://sns-avatar-qc.xhscdn.com/avatar/default.jpg'],
    thumbUrl: 'https://sns-avatar-qc.xhscdn.com/avatar/default.jpg',
  };
  assert.strictEqual(collectMessageImageUrls(fakeProductMsg).length, 0, '头像 URL 不应被当作商品图转发');

  console.log('[check-wechat-notice-order-info] passed');
}

main();
