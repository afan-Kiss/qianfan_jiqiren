const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qianfanApp', {
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  getPaths: () => ipcRenderer.invoke('app:get-paths'),
  ping: () => ipcRenderer.invoke('app:ping'),
  openConfigDir: () => ipcRenderer.invoke('app:open-config-dir'),
  openLogsDir: () => ipcRenderer.invoke('app:open-logs-dir'),
  syncTrayState: (state) => ipcRenderer.invoke('app:sync-tray-state', state),
  showTrayNotification: (payload) => ipcRenderer.invoke('app:show-tray-notification', payload),
  showMainWindow: () => ipcRenderer.invoke('app:show-main-window'),
  wechatHealth: () => ipcRenderer.invoke('app:wechat-health'),
  listWechatFriends: () => ipcRenderer.invoke('app:list-wechat-friends'),
  fetchAvatarDataUrl: (url) => ipcRenderer.invoke('app:fetch-avatar-data-url', url),
  getNotifyAccounts: () => ipcRenderer.invoke('app:get-notify-accounts'),
  setNotifyAccounts: (accounts) => ipcRenderer.invoke('app:set-notify-accounts', accounts),
  getUiPreferences: () => ipcRenderer.invoke('app:get-ui-preferences'),
  setAutoStart: (enabled) => ipcRenderer.invoke('app:set-auto-start', enabled),
  sendTestWechatMessage: (wxid) => ipcRenderer.invoke('app:send-test-wechat-message', wxid),
  prepareWechatRuntime: (options) => ipcRenderer.invoke('app:prepare-wechat-runtime', options),
  ensureWechatReady: (options) => ipcRenderer.invoke('app:ensure-wechat-ready', options),
  startRuntime: () => ipcRenderer.invoke('runtime:start'),
  stopRuntime: () => ipcRenderer.invoke('runtime:stop'),
  restartWorker: (workerName) => ipcRenderer.invoke('runtime:restart-worker', workerName),
  getRuntimeStatus: () => ipcRenderer.invoke('runtime:status'),
  onRuntimeStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('runtime:status:update', handler);
    return () => ipcRenderer.removeListener('runtime:status:update', handler);
  },
  onRuntimeLog: (callback) => {
    const handler = (_event, entry) => callback(entry);
    ipcRenderer.on('runtime:log', handler);
    return () => ipcRenderer.removeListener('runtime:log', handler);
  },
  onRuntimeStats: (callback) => {
    const handler = (_event, stats) => callback(stats);
    ipcRenderer.on('runtime:stats-update', handler);
    return () => ipcRenderer.removeListener('runtime:stats-update', handler);
  },
  startRelay: () => ipcRenderer.invoke('app:start-relay'),
  stopRelay: () => ipcRenderer.invoke('app:stop-relay'),
  startBot: () => ipcRenderer.invoke('app:start-bot'),
  stopBot: () => ipcRenderer.invoke('app:stop-bot'),
  getRelayState: () => ipcRenderer.invoke('app:get-relay-state'),
  getStatus: () => ipcRenderer.invoke('app:get-status'),
  getTodayStats: () => ipcRenderer.invoke('app:get-today-stats'),
  checkEnvironment: () => ipcRenderer.invoke('app:check-environment'),
  sendTestMessage: (wxid) => ipcRenderer.invoke('app:send-test-wechat-message', wxid),
  onStatusChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('app:status-changed', handler);
    return () => ipcRenderer.removeListener('app:status-changed', handler);
  },
  onTrayAction: (callback) => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on('tray:action', handler);
    return () => ipcRenderer.removeListener('tray:action', handler);
  },
  onOpenSettings: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('tray:open-settings', handler);
    return () => ipcRenderer.removeListener('tray:open-settings', handler);
  },
  onRelayLogLine: (callback) => {
    const handler = (_event, line) => callback(line);
    ipcRenderer.on('relay:log-line', handler);
    return () => ipcRenderer.removeListener('relay:log-line', handler);
  },
  onRelayProcessExit: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('relay:process-exit', handler);
    return () => ipcRenderer.removeListener('relay:process-exit', handler);
  },
});
