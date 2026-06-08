const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  Notification,
  ipcMain,
  dialog,
} = require('electron');
const { initAppRoot } = require('../shared/app-root');

initAppRoot(app);

const { ensureWxbotConfigFile } = require('../shared/config-bootstrap');
const { resolveProjectRoot } = require('../shared/app-root');
ensureWxbotConfigFile(path.join(resolveProjectRoot(), 'config.wxbot-new.json'));

const { verifyQianfanRelayLicense } = require('../shared/youdao-license-check');
const { registerIpcHandlers, stopBackendServices } = require('./ipc-bridge');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let shutdownFinished = false;
let appIcon = null;

const trayUiState = {
  statusKey: 'stopped',
  statusText: '未启动',
  relayRunning: false,
  starting: false,
};

function getRendererHtmlPath() {
  return path.join(__dirname, '..', 'renderer', 'index.html');
}

function getRendererDir() {
  return path.join(__dirname, '..', 'renderer');
}

function loadFallbackTrayIcon() {
  const fallbackPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFUlEQVR42mP8z8BQz0AEYBxVSFUAAP//AwD5FQF3f8p8WAAAAABJRU5ErkJggg==',
    'base64',
  );
  return nativeImage.createFromBuffer(fallbackPng);
}

async function loadAppIcon() {
  try {
    const icon = await app.getFileIcon(process.execPath, { size: 'small' });
    if (icon && !icon.isEmpty()) {
      appIcon = icon;
      return appIcon;
    }
  } catch {
    // ignore
  }

  const iconPath = path.join(getRendererDir(), 'icon.png');
  if (fs.existsSync(iconPath)) {
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) {
      appIcon = image;
      return appIcon;
    }
  }

  appIcon = loadFallbackTrayIcon();
  return appIcon;
}

function getWindowIcon() {
  if (appIcon && !appIcon.isEmpty()) return appIcon;
  return loadFallbackTrayIcon();
}

function createTrayIcon() {
  const source = getWindowIcon();
  return source.resize({ width: 16, height: 16, quality: 'best' });
}

function showMainWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`千帆客服台机器人 - ${trayUiState.statusText}`);
  tray.setContextMenu(buildTrayMenu());
}

function buildTrayMenu() {
  const relayRunning = trayUiState.relayRunning;
  const starting = trayUiState.starting;
  return Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: '启动中转',
      enabled: !relayRunning && !starting,
      click: () => mainWindow?.webContents.send('tray:action', 'start'),
    },
    {
      label: '停止中转',
      enabled: relayRunning && !starting,
      click: () => mainWindow?.webContents.send('tray:action', 'stop'),
    },
    {
      label: '检查环境',
      enabled: !starting,
      click: () => mainWindow?.webContents.send('tray:action', 'check'),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('千帆客服台机器人');
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => showMainWindow());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: '千帆客服台机器人',
    icon: getWindowIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(getRendererHtmlPath());
  mainWindow.setMenuBarVisibility(false);
  mainWindow.removeMenu();

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerTrayIpcHandlers() {
  ipcMain.handle('app:sync-tray-state', (_event, payload = {}) => {
    trayUiState.statusKey = payload.statusKey || 'stopped';
    trayUiState.statusText = payload.statusText || '未启动';
    trayUiState.relayRunning = Boolean(payload.relayRunning);
    trayUiState.starting = Boolean(payload.starting);
    updateTray();
    return true;
  });

  ipcMain.handle('app:show-tray-notification', (_event, payload = {}) => {
    if (!Notification.isSupported()) return false;
    new Notification({
      title: payload.title || '千帆客服台机器人',
      body: payload.body || '',
    }).show();
    return true;
  });

  ipcMain.handle('app:show-main-window', () => {
    showMainWindow();
    return true;
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(async () => {
    const license = await verifyQianfanRelayLicense();
    if (!license.ok) {
      await dialog.showMessageBox({
        type: 'error',
        title: '软件不可用',
        message: license.message || '软件不可用，请联系17364583794 同V',
        buttons: ['确定'],
        noLink: true,
      });
      app.quit();
      return;
    }

    Menu.setApplicationMenu(null);
    await loadAppIcon();
    registerIpcHandlers(app);
    registerTrayIpcHandlers();
    createTray();
    createWindow();
    app.on('activate', () => showMainWindow());
  });

  app.on('before-quit', (event) => {
    isQuitting = true;
    if (shutdownFinished) return;
    event.preventDefault();
    void stopBackendServices()
      .catch(() => {})
      .finally(() => {
        shutdownFinished = true;
        app.quit();
      });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && isQuitting) app.quit();
  });
}
