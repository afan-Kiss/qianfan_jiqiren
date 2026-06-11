const fs = require('fs');
const path = require('path');
const { resolveProjectRoot } = require('./app-root');

const DEFAULT_CDP_BRIDGE = {
  enabled: true,
  ports: [9222, 9223, 9224],
  devtoolsHost: '127.0.0.1',
  autoDiscoverTargets: true,
  injectOnNewDocument: true,
  enableNetworkObserver: true,
  saveRawFrames: true,
  savePayloadMaxLength: 20000,
  debugPayload: false,
  allowedUrlKeywords: ['qianfan', 'douyin', 'jinritemai', 'im', 'doudian', 'fxg'],
  blockedUrlKeywords: [],
  autoReplyEnabled: false,
  autoAftersaleEnabled: false,
  listenMs: 8000,
};

const DEFAULT_DOUDIAN = {
  enabled: false,
  bridgePort: 19527,
  autoInjectOnStart: false,
  installDir: '',
  originalInstallDir: 'D:\\抖店工作台\\1.1.7-login.1',
  testInstallDir: 'D:\\抖店工作台_bridge_test\\1.1.7-login.1',
  enableAsarPatch: false,
  devtoolsPorts: [9222, 9223, 9333, 4723],
  devtoolsHost: '127.0.0.1',
  processNames: ['抖店工作台.exe', '抖店.exe', 'doudian.exe', 'DouDian.exe'],
  pageMatchRules: {
    urlIncludes: ['jinritemai.com', 'doudian.com', 'fxg.jinritemai.com', 'im.jinritemai.com'],
    titleIncludes: ['抖店', '客服', '工作台', '消息'],
    servicePageHints: ['im', 'customer', 'chat', 'message', 'cs'],
  },
  selectors: {
    chatContainer: "[class*='chat'], [class*='message-list'], [class*='im-chat']",
    conversationList: "[class*='conversation'], [class*='session-list']",
    messageInput: "textarea, [contenteditable='true'], input[type='text']",
    sendButton: "button[class*='send'], [class*='send-btn']",
    aftersaleCard: "[class*='aftersale'], [class*='refund'], [class*='售后']",
    orderCard: "[class*='order-card'], [class*='order-info']",
  },
  messageMergeWindowMs: 8000,
  dedupeWindowMs: 60000,
  sendTimeoutMs: 15000,
  heartbeatIntervalMs: 30000,
  heartbeatTimeoutMs: 90000,
  debugRawPayload: false,
  redactSensitiveFields: true,
  knownShops: [
    { shopId: '263636465', shopName: 'XY祥钰珠宝' },
    { shopId: '276595872', shopName: '梵诗娅珠宝' },
  ],
};

let cachedConfig = null;

function loadConfig() {
  if (cachedConfig) return cachedConfig;
  const root = resolveProjectRoot();
  const candidates = [
    path.join(root, 'config.json'),
    path.join(root, 'config.wxbot-new.json'),
    path.join(root, 'config.example.json'),
  ];
  let raw = {};
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        break;
      } catch {
        // try next
      }
    }
  }
  cachedConfig = {
    ...raw,
    doudian: { ...DEFAULT_DOUDIAN, ...(raw.doudian || {}) },
    cdpBridge: { ...DEFAULT_CDP_BRIDGE, ...(raw.cdpBridge || {}) },
  };
  return cachedConfig;
}

function getDoudianConfig() {
  return loadConfig().doudian;
}

function getCdpBridgeConfig() {
  const cfg = loadConfig().cdpBridge || DEFAULT_CDP_BRIDGE;
  const doudian = loadConfig().doudian || {};
  return {
    ...DEFAULT_CDP_BRIDGE,
    ...cfg,
    ports: cfg.ports || doudian.devtoolsPorts || DEFAULT_CDP_BRIDGE.ports,
    devtoolsHost: cfg.devtoolsHost || doudian.devtoolsHost || DEFAULT_CDP_BRIDGE.devtoolsHost,
  };
}

function reloadConfig() {
  cachedConfig = null;
  return loadConfig();
}

module.exports = {
  DEFAULT_DOUDIAN,
  DEFAULT_CDP_BRIDGE,
  loadConfig,
  getDoudianConfig,
  getCdpBridgeConfig,
  reloadConfig,
};
