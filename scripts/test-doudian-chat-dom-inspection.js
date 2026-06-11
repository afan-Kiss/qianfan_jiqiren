#!/usr/bin/env node
/**
 * 聊天 DOM 诊断评分测试
 * npm run doudian:test-chat-dom-inspection
 */
const {
  analyzeDomInspection,
  scoreBubble,
  scoreMessageArea,
  TRUSTED_AREA_SCORE,
  TRUSTED_BUBBLE_SCORE,
} = require('../src/platforms/doudian/doudian-chat-dom-trust');
const { validateDoudianMessageBeforeInsert, getKnownShopIds } = require('../src/platforms/doudian/doudian-history-validation');
const { getDoudianConfig } = require('../src/shared/config');

function buildMockInspection() {
  return {
    viewport: { width: 1400, height: 900 },
    scrollContainers: [
      {
        selectorPath: 'div.chat-scroll',
        scrollHeight: 1200,
        clientHeight: 600,
        zone: 'center_unknown',
      },
    ],
    candidateMessageAreas: [
      {
        tag: 'div',
        className: 'im-chat-message-list scroll',
        rect: { x: 320, y: 120, width: 520, height: 640 },
        scrollHeight: 1800,
        clientHeight: 640,
        textLength: 420,
        sampleText: '昨天 20:08\n在在在\n转人工',
        selectorPath: 'div.im-chat > div.message-list',
        score: 55,
        reason: ['height_ok', 'scrollable', 'center_x', 'time_text'],
        zone: 'center_unknown',
      },
      {
        tag: 'div',
        className: 'customer-profile-panel',
        rect: { x: 980, y: 80, width: 300, height: 700 },
        scrollHeight: 700,
        clientHeight: 700,
        textLength: 180,
        sampleText: '客户资料\n店铺消费',
        selectorPath: 'div.profile-panel',
        score: 5,
        reason: ['excluded_zone'],
        zone: 'right_profile',
      },
      {
        tag: 'div',
        className: 'quick-phrase-list',
        rect: { x: 300, y: 760, width: 500, height: 120 },
        scrollHeight: 120,
        clientHeight: 120,
        textLength: 60,
        sampleText: '个人短语\n团队短语',
        selectorPath: 'div.quick-phrase',
        score: -20,
        zone: 'quick_phrase',
      },
    ],
    candidateBubbles: [
      {
        selectorPath: 'div.bubble.buyer-msg',
        parentSelectorPath: 'div.message-list',
        text: '在在在',
        messageType: 'text',
        directionGuess: 'buyer',
        rect: { x: 360, y: 220, width: 120, height: 36 },
        nearTimeText: '昨天 20:08',
        score: 42,
        rejectReason: '',
        zone: 'center_unknown',
      },
      {
        selectorPath: 'div.bubble.seller-msg',
        parentSelectorPath: 'div.message-list',
        text: '您好，请问需要什么帮助',
        messageType: 'text',
        directionGuess: 'seller',
        rect: { x: 520, y: 280, width: 200, height: 40 },
        nearTimeText: '20:08:56',
        score: 45,
        rejectReason: '',
        zone: 'center_unknown',
      },
      {
        selectorPath: 'div.profile-panel',
        text: '添加备注',
        directionGuess: 'unknown',
        rect: { x: 1000, y: 200, width: 180, height: 30 },
        score: 0,
        rejectReason: 'ui_noise_text',
        zone: 'right_profile',
      },
      {
        selectorPath: 'div.product-card',
        text: '抖音-商品详情页 抖音电商大连自营旗舰店',
        directionGuess: 'unknown',
        rect: { x: 990, y: 400, width: 260, height: 120 },
        score: 0,
        rejectReason: 'excluded_zone',
        zone: 'order_card',
      },
    ],
    excludedAreas: [
      { zone: 'right_profile', sampleText: '客户资料' },
      { zone: 'quick_phrase', sampleText: '个人短语' },
    ],
    textSamples: ['在在在', '转人工', '昨天 20:08'],
  };
}

function main() {
  const knownShops = getDoudianConfig().knownShops || [];
  const knownShopIds = getKnownShopIds(knownShops);
  const activeShopId = '263636465';
  const mock = buildMockInspection();
  const analysis = analyzeDomInspection(mock);

  const messageAreaDetected = analysis.candidateMessageAreaCount > 0 && analysis.trustedMessageAreaCount > 0;
  const bubbleDetected = analysis.trustedBubbleCount >= 2;

  const uiBubble = scoreBubble(
    { text: '个人短语', directionGuess: 'unknown', parentSelectorPath: 'div.quick-phrase' },
    { trusted: false }
  );
  const sideBubble = scoreBubble(
    { text: '添加备注', directionGuess: 'unknown', parentSelectorPath: 'div.profile-panel' },
    { trusted: false }
  );

  const uiArea = scoreMessageArea({
    className: 'quick-phrase-list',
    rect: { width: 400, height: 100 },
    textLength: 40,
    sampleText: '个人短语',
  });
  const sideArea = scoreMessageArea({
    className: 'customer-profile-panel',
    rect: { width: 300, height: 500 },
    textLength: 100,
    sampleText: '客户资料 店铺消费',
  });

  const wrongShopValidation = validateDoudianMessageBeforeInsert(
    {
      shopId: '213196845',
      shopName: '抖音电商大连自营旗舰店',
      conversationId: 'conv1',
      buyerId: 'buyer1',
      direction: 'buyer',
      text: '在在在',
      source: 'dom',
      domArea: 'chatBubbleArea',
    },
    { activeShopId, knownShopIds, knownShops }
  );

  const goodValidation = validateDoudianMessageBeforeInsert(
    {
      shopId: activeShopId,
      shopName: 'XY祥钰珠宝',
      conversationId: 'conv1',
      buyerId: 'buyer1',
      direction: 'buyer',
      text: '在在在',
      source: 'dom',
      domArea: 'chatBubbleArea',
    },
    { activeShopId, knownShopIds, knownShops, conversationId: 'conv1', buyerId: 'buyer1' }
  );

  const summary = {
    success:
      messageAreaDetected &&
      bubbleDetected &&
      !uiBubble.trusted &&
      !sideBubble.trusted &&
      !uiArea.trusted &&
      !sideArea.trusted &&
      !wrongShopValidation.ok &&
      goodValidation.ok,
    messageAreaDetected,
    bubbleDetected,
    uiAreaRejected: !uiArea.trusted,
    sidePanelRejected: !sideBubble.trusted && !sideArea.trusted,
    uiBuyerNameRejected: !uiBubble.trusted,
    shopNotOverwrittenByCard: !wrongShopValidation.ok,
    trustedMessageAreaCount: analysis.trustedMessageAreaCount,
    trustedBubbleCount: analysis.trustedBubbleCount,
    trustedAreaThreshold: TRUSTED_AREA_SCORE,
    trustedBubbleThreshold: TRUSTED_BUBBLE_SCORE,
    bestMessageAreaScore: analysis.bestMessageArea?.score || 0,
    bestBubbleSamples: analysis.bestBubbleSamples,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.success ? 0 : 1);
}

main();
