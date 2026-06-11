const SEARCH_KEYWORDS = [
  'BrowserWindow',
  'BrowserView',
  'webContents',
  'webview',
  'webviewTag',
  'preload',
  'executeJavaScript',
  'did-finish-load',
  'dom-ready',
  'ipc:message',
  'ipc:hello',
  'app:electronRenderReady',
  'im_container',
  'ops_container',
  'msg_box',
  'pc_seller_desk_v2',
  'main/workspace',
  'pigeon.jinritemai.com',
  'get_current_conversation_list',
  'get_link_info',
  'createWSByAccount',
  'onSDK_CHANNEL',
  'chantListScrollArea',
  'chat_list',
  'im.jinritemai.com',
  'fxg.jinritemai.com',
];

const PRIORITY_URLS = [
  'im.jinritemai.com/pc_seller_desk_v2/main/workspace',
  'fxg.jinritemai.com',
  'pigeon.jinritemai.com',
];

const ENTRY_CANDIDATES = [
  'electron\\main.js',
  'electron\\webview_preload_index.js',
  'electron\\webview_preload_vendor.js',
  'electron\\browser_preload_index.js',
  'electron\\browserview_preload_index.js',
  'build\\pages\\im_container\\index.html',
  'build\\pages\\im_container\\index.js',
  'build\\pages\\ops_container\\index.html',
  'build\\pages\\ops_container\\index.js',
  'build\\pages\\msg_box\\index.html',
  'build\\pages\\msg_box\\index.js',
  'node_modules\\@modern-js\\electron-runtime\\dist\\js\\node\\preload\\webviewBridge.js',
  'node_modules\\@modern-js\\electron-runtime\\dist\\js\\node\\services\\webview\\electron-webview\\webview.js',
  'node_modules\\@modern-js\\electron-runtime\\dist\\js\\node\\services\\windows\\electron-main\\windows.js',
];

const CONFIG_FILES = [
  'tt_electron_config.json',
  'shell_config.json',
  'launcher_config.json',
  'lynx_core.js',
  'md5.json',
];

const SENSITIVE_LOG_PATTERNS = [
  /cookie/i,
  /authorization/i,
  /token/i,
  /csrf/i,
  /x-ms-token/i,
  /bd-ticket/i,
  /sessionid/i,
];

module.exports = {
  SEARCH_KEYWORDS,
  PRIORITY_URLS,
  ENTRY_CANDIDATES,
  CONFIG_FILES,
  SENSITIVE_LOG_PATTERNS,
};
