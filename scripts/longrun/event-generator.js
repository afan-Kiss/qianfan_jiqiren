function createSeededRandom(seed) {
  let state = Number(seed) >>> 0 || 1;
  return function next() {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(input) {
  let h = 2166136261;
  const text = String(input);
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

class EventGenerator {
  constructor(options = {}) {
    this.seed = Number(options.seed || 1001);
    this.rand = createSeededRandom(this.seed);
    this.clock = options.clock || null;
    this.runId = options.runId || 'longrun';
    this.shopTitle = options.shopTitle || '长跑模拟店铺';
    this.appCid = options.appCid || `longrun-app-${this.runId}`;
    this.pendingByKey = new Map();
    this.sequence = 0;
  }

  nextSequence() {
    this.sequence += 1;
    return this.sequence;
  }

  nextBuyerMessage(dayIndex) {
    const seq = this.nextSequence();
    const messageId = `buyer-${this.seed}-d${dayIndex}-n${seq}`;
    const buyerId = `buyer-${(seq % 50) + 1}`;
    const createAt = this.clock ? this.clock.now() : Date.now();
    return {
      type: 'buyer',
      dayIndex,
      messageId,
      buyerId,
      traceId: `trace-${messageId}`,
      message: {
        shopTitle: this.shopTitle,
        appCid: this.appCid,
        buyerNick: `买家${buyerId}`,
        buyerId,
        msgId: messageId,
        messageId,
        text: `模拟买家消息 ${messageId}`,
        contentType: 'text',
        createAt,
        senderAppUid: `${buyerId}-uid`,
        receiverAppUids: [`receiver-${buyerId}`],
        source: 'longrun_buyer_message',
      },
    };
  }

  nextWechatReply(pendingReply, dayIndex) {
    const replyId = pendingReply?.replyId;
    const wxMsgId = `wx-reply-${this.seed}-d${dayIndex}-r${replyId}`;
    return {
      type: 'reply',
      dayIndex,
      replyId,
      wxMsgId,
      traceId: pendingReply?.traceId || `trace-reply-${replyId}`,
      text: `#${replyId} 长跑模拟回复 ${wxMsgId}`,
      pendingKey: pendingReply?.pendingKey,
    };
  }

  duplicateEvent(event) {
    return {
      ...event,
      duplicate: true,
      duplicateOf: event.messageId || event.wxMsgId || event.replyId,
    };
  }

  outOfOrderEvents(events) {
    const copy = [...events];
    if (copy.length < 2) return copy;
    const i = Math.floor(this.rand() * (copy.length - 1));
    const tmp = copy[i];
    copy[i] = copy[i + 1];
    copy[i + 1] = tmp;
    return copy;
  }

  generateDay(dayIndex, profile = {}) {
    const buyerMessagesPerDay = Number(profile.buyerMessagesPerDay || 10);
    const replyRate = Number(profile.replyRate ?? 0.8);
    const duplicateRate = Number(profile.duplicateRate ?? 0.2);
    const outOfOrderRate = Number(profile.outOfOrderRate ?? 0.05);
    const events = [];

    for (let i = 0; i < buyerMessagesPerDay; i += 1) {
      const buyer = this.nextBuyerMessage(dayIndex);
      events.push(buyer);
      if (this.rand() < duplicateRate) {
        events.push(this.duplicateEvent(buyer));
      }
    }

    if (this.rand() < outOfOrderRate && events.length > 1) {
      return this.outOfOrderEvents(events);
    }
    return events.map((event) => ({ ...event, replyRate }));
  }

  shouldReply(profile = {}) {
    return this.rand() < Number(profile.replyRate ?? 0.8);
  }

  shouldDuplicate(profile = {}) {
    return this.rand() < Number(profile.duplicateRate ?? 0.2);
  }

  rememberPending(key, pending) {
    this.pendingByKey.set(key, pending);
  }

  getPending(key) {
    return this.pendingByKey.get(key);
  }
}

module.exports = {
  EventGenerator,
  createSeededRandom,
  hashSeed,
};
