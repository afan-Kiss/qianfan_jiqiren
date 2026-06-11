const PLATFORM = 'doudian';

const BRIDGE_EVENTS = {
  HELLO: 'bridge.hello',
  READY: 'bridge.ready',
  HEARTBEAT: 'bridge.heartbeat',
  ERROR: 'bridge.error',
};

const DOUDIAN_EVENTS = {
  CONVERSATION_LIST: 'doudian.conversation.list',
  CONVERSATION_ACTIVE: 'doudian.conversation.active',
  MESSAGE_INBOUND: 'doudian.message.inbound',
  MESSAGE_OUTBOUND: 'doudian.message.outbound',
  MESSAGE_ACK: 'doudian.message.ack',
  MESSAGE_SEND_FAILED: 'doudian.message.send_failed',
  ORDER_CONTEXT: 'doudian.order.context',
  AFTERSALE_CREATED: 'doudian.aftersale.created',
  AFTERSALE_UPDATED: 'doudian.aftersale.updated',
  AFTERSALE_MESSAGE: 'doudian.aftersale.message',
  AFTERSALE_NEED_HANDLE: 'doudian.aftersale.need_handle',
  RUNTIME_STATUS: 'doudian.runtime.status',
  RUNTIME_LOG: 'doudian.runtime.log',
  SHOP_DETECTED: 'doudian.shop.detected',
  SHOP_IDENTITY_RESOLVED: 'doudian.shop.identity_resolved',
  MESSAGE_OBSERVER_READY: 'doudian.message.observer_ready',
  MESSAGE_DOM_SNAPSHOT: 'doudian.message.dom_snapshot',
  MESSAGE_DOM_ADDED: 'doudian.message.dom_added',
  MESSAGE_NETWORK_CANDIDATE: 'doudian.message.network_candidate',
  MESSAGE_DOM_CANDIDATE: 'doudian.message.dom_candidate',
  MESSAGE_REAL_CANDIDATE: 'doudian.message.real_candidate',
  CHAT_HISTORY_SNAPSHOT: 'doudian.chat.history_snapshot',
  CHAT_DOM_INSPECTION: 'doudian.chat.dom_inspection',
  CHAT_HISTORY_CANDIDATE: 'doudian.chat.history_candidate',
  CHAT_CONVERSATION_HINTS: 'doudian.chat.conversation_hints',
  REPLY_EDITOR_INSPECTION: 'doudian.reply.editor_inspection',
  REPLY_DRAFT_FILLED: 'doudian.reply.draft_filled',
  MESSAGE_SEND_RESULT: 'doudian.message.send_result',
  CONVERSATION_LIST_CAPTURED: 'doudian.conversation.list_captured',
  CONVERSATION_SOURCES_INSPECTION: 'doudian.conversation.sources_inspection',
  NETWORK_BUFFER_REPLAY: 'doudian.network.buffer_replay',
  IM_DOM_DIAGNOSTIC: 'doudian.im.dom_diagnostic',
  IM_EMPTY_STATE: 'doudian.im.empty_state',
  CONVERSATION_EMPTY: 'doudian.conversation.empty',
  WORKER_NETWORK_CANDIDATE: 'doudian.worker.network_candidate',
  MEMORY_CACHE_CANDIDATE: 'doudian.memory_cache.candidate',
  STDOUT_BUSINESS_SIGNAL: 'doudian.stdout.business_signal',
  UI_NOISE: 'doudian.ui.noise',
};

const SEND_TASK_EVENT = 'doudian.message.send_task';

const ALL_EVENT_TYPES = new Set([
  ...Object.values(BRIDGE_EVENTS),
  ...Object.values(DOUDIAN_EVENTS),
  SEND_TASK_EVENT,
]);

function createEnvelope(type, fields = {}) {
  return {
    platform: PLATFORM,
    type,
    bridgeId: fields.bridgeId || '',
    shopId: fields.shopId || '',
    shopName: fields.shopName || '',
    conversationId: fields.conversationId || '',
    buyerId: fields.buyerId || '',
    messageId: fields.messageId || '',
    timestamp: fields.timestamp || Date.now(),
    payload: fields.payload || {},
    raw: fields.raw || {},
  };
}

const INJECTION_ROUTES = {
  NONE: 'none',
  CDP: 'cdp',
  ASAR: 'asar',
  ASAR_ANALYSIS: 'asar_analysis',
};

function createRuntimeStatus(status = {}) {
  return {
    doudianClientFound: Boolean(status.doudianClientFound),
    doudianPageFound: Boolean(status.doudianPageFound),
    doudianBridgeInjected: Boolean(status.doudianBridgeInjected),
    doudianBridgeConnected: Boolean(status.doudianBridgeConnected),
    doudianListenerReady: Boolean(status.doudianListenerReady),
    doudianSenderReady: Boolean(status.doudianSenderReady),
    doudianAftersaleReady: Boolean(status.doudianAftersaleReady),
    injectionRoute: status.injectionRoute || INJECTION_ROUTES.NONE,
    asarPatched: Boolean(status.asarPatched),
    asarAnalyzed: Boolean(status.asarAnalyzed),
    cdpAvailable: Boolean(status.cdpAvailable),
    lastHeartbeatAt: status.lastHeartbeatAt || 0,
    lastError: status.lastError || '',
    bridgeId: status.bridgeId || '',
    pageId: status.pageId || '',
    pageTitle: status.pageTitle || '',
    pageUrl: status.pageUrl || '',
    devtoolsPort: status.devtoolsPort || 0,
    installDir: status.installDir || '',
    updatedAt: Date.now(),
  };
}

module.exports = {
  PLATFORM,
  BRIDGE_EVENTS,
  DOUDIAN_EVENTS,
  SEND_TASK_EVENT,
  ALL_EVENT_TYPES,
  INJECTION_ROUTES,
  createEnvelope,
  createRuntimeStatus,
};
