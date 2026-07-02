const fs = require('fs');
const path = require('path');
const { resolveProjectRoot, resolveRuntimeRoot } = require('./app-root');

function resolveExampleFile() {
  const candidates = [
    path.join(resolveProjectRoot(), 'config.wxbot-new.example.json'),
    path.join(resolveRuntimeRoot(), 'config.wxbot-new.example.json'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return candidates[0];
}

function buildDefaultConfig() {
  const exampleFile = resolveExampleFile();
  if (fs.existsSync(exampleFile)) {
    try {
      return JSON.parse(fs.readFileSync(exampleFile, 'utf8'));
    } catch {
      // fall through
    }
  }
  return {
    ui: { autoStart: false },
    qianfanDebug: {
      enabled: true,
      devtoolsPort: 9322,
      devtoolsHost: '127.0.0.1',
      qianfanClientExePath: 'E:\\千帆\\eva\\千帆客服工作台.exe',
      qianfanClientWorkingDir: 'E:\\千帆\\eva',
      qianfanClientProcessName: '千帆客服工作台.exe',
      autoLaunchQianfanClientWhenMissing: true,
      autoCloseExistingQianfanClient: false,
      expectedShopCount: 4,
      waitTimeoutMs: 60000,
      checkIntervalMs: 2000,
      closeWaitMs: 10000,
    },
  };
}

function ensureWxbotConfigFile(configFile = path.join(resolveProjectRoot(), 'config.wxbot-new.json')) {
  if (fs.existsSync(configFile)) {
    return { created: false, configFile };
  }
  const dir = path.dirname(configFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const template = buildDefaultConfig();
  fs.writeFileSync(configFile, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
  return { created: true, configFile };
}

module.exports = {
  ensureWxbotConfigFile,
  buildDefaultConfig,
};
