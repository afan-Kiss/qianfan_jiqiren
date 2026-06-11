const { DOUDIAN_EVENTS } = require('./doudian-types');
const { DoudianDedupe } = require('./doudian-dedupe');
const {
  parsePigeonPayload,
  isRealMessageCandidate,
  resolveApiName,
  serializeSafePayload,
} = require('./doudian-pigeon-parser');
const {
  insertMessage,
  insertCaptureCandidate,
  upsertConversation,
} = require('./doudian-data-store');
const { buildShopKey, pickFirst, maskMessageForReport } = require('./doudian-shop-utils');

class DoudianBusinessPipeline {
  constructor(options = {}) {
    this.dedupe = options.dedupe || new DoudianDedupe();
    this.stats = {
      memoryCacheBusinessEventCount: 0,
      shopIdentityEventCount: 0,
      conversationListEventCount: 0,
      conversationEmptyEventCount: 0,
      realMessageCandidateEventCount: 0,
      platformConversationUpsertCount: 0,
      platformMessageInsertCount: 0,
      lastMessageAt: 0,
      lastError: '',
      conversationCount: 0,
      realMessageCount: 0,
    };
    this.onBusinessEvent = options.onBusinessEvent || null;
    this.onRealBuyerMessage = options.onRealBuyerMessage || null;
    this.emitSyntheticEvents = Boolean(options.emitSyntheticEvents);
  }

  bump(stat, n = 1) {
    if (this.stats[stat] != null) this.stats[stat] += n;
    this.stats.memoryCacheBusinessEventCount += n;
  }

  emitEvent(type, envelopeBase, payload) {
    const envelope = {
      platform: 'doudian',
      type,
      bridgeId: envelopeBase.bridgeId || '',
      timestamp: Date.now(),
      payload,
    };
    if (this.onBusinessEvent) this.onBusinessEvent(envelope);
    return envelope;
  }

  processEnvelope(envelope) {
    try {
      switch (envelope.type) {
        case DOUDIAN_EVENTS.MEMORY_CACHE_CANDIDATE:
          return this.handleMemoryCacheCandidate(envelope);
        case DOUDIAN_EVENTS.SHOP_IDENTITY_RESOLVED:
          return this.handleShopIdentityResolved(envelope);
        case DOUDIAN_EVENTS.CONVERSATION_LIST:
          return this.handleConversationList(envelope);
        case DOUDIAN_EVENTS.MESSAGE_REAL_CANDIDATE:
          return this.handleRealMessageCandidate(envelope);
        case DOUDIAN_EVENTS.CONVERSATION_EMPTY:
          return this.handleConversationEmpty(envelope);
        default:
          return null;
      }
    } catch (err) {
      this.stats.lastError = String(err.message || err).slice(0, 200);
      return null;
    }
  }

  handleMemoryCacheCandidate(envelope) {
    const p = envelope.payload || {};
    const cacheKey = p.cacheKey || '';
    let payload = null;

    if (p.safePayload) {
      try {
        payload = JSON.parse(p.safePayload);
      } catch {
        payload = null;
      }
    }

    if (!payload && p.rawPayload) {
      payload = p.rawPayload;
    }

    const parsed = payload
      ? parsePigeonPayload(payload, { cacheKey, sessionPartitionKey: p.shopInfo?.sessionPartitionKey })
      : this.parseFromSummary(p, cacheKey);

    if (!parsed.ok && !p.shopInfo) return null;

    const shopInfo = {
      shopId: pickFirst(parsed.shopInfo?.shopId, p.shopInfo?.shopId),
      shopName: pickFirst(parsed.shopInfo?.shopName, p.shopInfo?.shopName),
      accountId: pickFirst(parsed.shopInfo?.accountId, p.shopInfo?.accountId),
      sessionPartitionKey: pickFirst(parsed.shopInfo?.sessionPartitionKey, p.shopInfo?.sessionPartitionKey),
    };

    let apiName = pickFirst(
      p.apiName,
      parsed.apiName && parsed.apiName !== 'unknown' ? parsed.apiName : '',
      resolveApiName(cacheKey)
    );
    if (apiName === 'unknown' && Number(p.conversationCount || 0) === 0 && parsed.conversations.length === 0) {
      apiName = 'get_current_conversation_list';
    }
    if (apiName === 'unknown' && (shopInfo.shopId || shopInfo.shopName || shopInfo.accountId)) {
      apiName = 'currentuser';
    }
    const source = p.source || 'memory_cache';

    insertCaptureCandidate({
      captureType: 'memory_cache',
      apiName,
      shopId: shopInfo.shopId,
      shopName: shopInfo.shopName,
      source,
      bridgeType: p.bridgeType || 'preload_ipc',
      bridgeId: envelope.bridgeId,
      raw: { cacheKey, conversationCount: parsed.conversationCount },
    });

    if (
      (apiName === 'currentuser' || (shopInfo.shopId && shopInfo.shopName && apiName !== 'get_link_info')) &&
      (shopInfo.shopId || shopInfo.shopName || shopInfo.accountId)
    ) {
      this.handleShopIdentityResolved(
        this.emitEvent(DOUDIAN_EVENTS.SHOP_IDENTITY_RESOLVED, envelope, { source, shopInfo })
      );
    }

    if (apiName === 'get_current_conversation_list') {
      if (parsed.emptyState?.isEmpty || parsed.conversations.length === 0) {
        this.handleConversationEmpty(
          this.emitEvent(DOUDIAN_EVENTS.CONVERSATION_EMPTY, envelope, {
            source,
            shopInfo,
            reason: 'conversation_list_empty',
          })
        );
      } else {
        this.handleConversationList(
          this.emitEvent(DOUDIAN_EVENTS.CONVERSATION_LIST, envelope, {
            source,
            shopInfo,
            conversationCount: parsed.conversations.length,
            conversations: parsed.conversations,
          })
        );
      }
    }

    if (
      parsed.messages.length > 0 &&
      apiName !== 'get_current_conversation_list' &&
      apiName !== 'currentuser'
    ) {
      this.handleRealMessageCandidate(
        this.emitEvent(DOUDIAN_EVENTS.MESSAGE_REAL_CANDIDATE, envelope, {
          source,
          shopInfo,
          items: parsed.messages,
        })
      );
    }

    return parsed;
  }

  parseFromSummary(p, cacheKey) {
    const apiName = p.apiName || resolveApiName(cacheKey);
    const shopInfo = p.shopInfo || {};
    const items = Array.isArray(p.items) ? p.items : [];
    const conversations = items
      .map((item) => ({
        conversationId: item.conversationId || '',
        buyerId: item.buyerId || '',
        buyerName: item.buyerName || '',
        lastMessageText: item.text || '',
        lastMessageTime: 0,
        unreadCount: Number(item.unreadCount || 0),
        status: item.status || '',
        rawTextHash: item.rawTextHash || '',
      }))
      .filter((c) => c.conversationId || c.buyerId || c.buyerName);

    return {
      ok: true,
      apiName,
      shopInfo,
      conversations,
      messages: [],
      emptyState:
        apiName === 'get_current_conversation_list' && conversations.length === 0
          ? { isEmpty: true, reason: 'conversation_list_empty' }
          : { isEmpty: false, reason: '' },
      conversationCount: Number(p.conversationCount || conversations.length),
      messageCount: 0,
    };
  }

  handleShopIdentityResolved(envelope) {
    const p = envelope.payload || {};
    const shopInfo = p.shopInfo || {};
    if (!shopInfo.shopId && !shopInfo.shopName && !shopInfo.accountId) return envelope;

    this.bump('shopIdentityEventCount');

    insertCaptureCandidate({
      captureType: 'shop_identity',
      shopId: shopInfo.shopId,
      shopName: shopInfo.shopName,
      source: p.source || 'memory_cache',
      bridgeId: envelope.bridgeId,
      raw: { shopInfo },
    });

    return envelope;
  }

  handleConversationList(envelope) {
    const p = envelope.payload || {};
    const shopInfo = p.shopInfo || {};
    const conversations = Array.isArray(p.conversations) ? p.conversations : [];

    this.bump('conversationListEventCount');
    this.stats.conversationCount = Math.max(this.stats.conversationCount, conversations.length);

    for (const conv of conversations) {
      if (!conv.conversationId && !conv.buyerId) continue;
      const convId = conv.conversationId || `buyer:${conv.buyerId}`;
      upsertConversation({
        platform: 'doudian',
        shopId: shopInfo.shopId || conv.shopId || '',
        shopName: shopInfo.shopName || conv.shopName || '',
        conversationId: convId,
        buyerId: conv.buyerId || '',
        buyerName: conv.buyerName || '',
        lastMessage: conv.lastMessageText || '',
        lastMessageAt: conv.lastMessageTime || Date.now(),
        unreadCount: conv.unreadCount || 0,
        takeoverStatus: 'auto',
      });
      this.stats.platformConversationUpsertCount += 1;
    }

    insertCaptureCandidate({
      captureType: 'conversation_list',
      apiName: 'get_current_conversation_list',
      shopId: shopInfo.shopId,
      shopName: shopInfo.shopName,
      source: p.source || 'memory_cache',
      bridgeId: envelope.bridgeId,
      raw: { conversationCount: conversations.length },
    });

    return envelope;
  }

  handleConversationEmpty(envelope) {
    const p = envelope.payload || {};
    this.bump('conversationEmptyEventCount');
    this.stats.conversationCount = 0;

    insertCaptureCandidate({
      captureType: 'conversation_empty',
      apiName: 'get_current_conversation_list',
      shopId: p.shopInfo?.shopId,
      shopName: p.shopInfo?.shopName,
      source: p.source || 'memory_cache',
      bridgeId: envelope.bridgeId,
      raw: { reason: p.reason || 'conversation_list_empty' },
    });

    return envelope;
  }

  handleRealMessageCandidate(envelope) {
    const p = envelope.payload || {};
    const shopInfo = p.shopInfo || {};
    const items = Array.isArray(p.items) ? p.items : [];

    for (const item of items) {
      if (!isRealMessageCandidate(item)) continue;

      this.bump('realMessageCandidateEventCount');
      this.stats.realMessageCount += 1;

      const normalized = {
        platform: 'doudian',
        shopId: shopInfo.shopId || item.shopId || '',
        shopName: shopInfo.shopName || item.shopName || '',
        conversationId: item.conversationId || '',
        buyerId: item.buyerId || '',
        buyerName: item.buyerName || '',
        messageId: item.messageId || '',
        direction: item.direction === 'seller' ? 'outbound' : 'inbound',
        messageType: item.messageType || 'text',
        text: item.text || '',
        timestamp: item.timestamp || Date.now(),
        rawTextHash: item.rawTextHash || '',
        source: p.source || 'memory_cache',
        bridgeId: envelope.bridgeId || '',
      };

      if (this.dedupe.isDuplicate(normalized)) continue;

      insertMessage(normalized);
      this.stats.platformMessageInsertCount += 1;
      this.stats.lastMessageAt = normalized.timestamp;

      if (normalized.direction === 'inbound' && normalized.buyerId) {
        if (this.onRealBuyerMessage) {
          this.onRealBuyerMessage(maskMessageForReport(normalized));
        }
      }
    }

    return envelope;
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = {
  DoudianBusinessPipeline,
};
