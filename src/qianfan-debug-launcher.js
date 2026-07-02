/**
 * 千帆 DevTools 接入：优先 attach 现有调试端口，仅在明确配置时才启动浏览器
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { fetchDevToolsJsonList, getPageTargets } = require('./devtools-list');
const { detectQianfanShopPages } = require('./page-finder');
const { println } = require('./utils');

const DEFAULT_BROWSER_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveDebugConfig(cfg = {}) {
  const root = cfg.root || path.resolve(__dirname, '..');
  const userDataDir = path.isAbsolute(cfg.userDataDir || '')
    ? cfg.userDataDir
    : path.join(root, cfg.userDataDir || 'runtime/qianfan-debug-profile');
  const mode = cfg.mode === 'launch_browser' ? 'launch_browser' : cfg.mode === 'attach_existing' ? 'attach_existing' : 'launch_client';

  return {
    enabled: cfg.enabled !== false,
    mode,
    autoLaunchBrowserWhenMissing: cfg.autoLaunchBrowserWhenMissing === true,
    autoLaunchQianfanClientWhenMissing: cfg.autoLaunchQianfanClientWhenMissing !== false,
    autoCloseExistingQianfanClient: cfg.autoCloseExistingQianfanClient === true,
    expectedShopCount: Number(cfg.expectedShopCount || 4),
    devtoolsPort: Number(cfg.devtoolsPort || 9223),
    devtoolsHost: cfg.devtoolsHost || '127.0.0.1',
    browserExePath: String(cfg.browserExePath || '').trim(),
    userDataDir,
    urls:
      Array.isArray(cfg.urls) && cfg.urls.length
        ? cfg.urls
        : ['https://edith.xiaohongshu.com', 'https://walle.xiaohongshu.com/cstools/seller/dashboard'],
    waitTimeoutMs: Number(cfg.waitTimeoutMs || 60000),
    checkIntervalMs: Number(cfg.checkIntervalMs || 2000),
    sameErrorPrintIntervalMs: Number(cfg.sameErrorPrintIntervalMs || 10000),
    root,
  };
}

function shouldAutoLaunchBrowser(config) {
  return config.mode === 'launch_browser' || config.autoLaunchBrowserWhenMissing === true;
}

function findBrowserExe(config) {
  if (config.browserExePath && fs.existsSync(config.browserExePath)) {
    return config.browserExePath;
  }
  for (const p of DEFAULT_BROWSER_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

async function probeDevTools(config) {
  const base = `http://${config.devtoolsHost}:${config.devtoolsPort}`;
  try {
    const versionRes = await fetch(`${base}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!versionRes.ok) {
      return { ok: false, occupied: true, reason: `HTTP ${versionRes.status}` };
    }
    const version = await versionRes.json();
    if (!version || !version.Browser) {
      return { ok: false, occupied: true, reason: 'not_chrome_devtools' };
    }

    const list = await fetchDevToolsJsonList(config.devtoolsPort, config.devtoolsHost);
    const pageCount = getPageTargets(list).length;
    return { ok: true, pageCount, list, browser: version.Browser };
  } catch (err) {
    const msg = String(err.message || err);
    if (/fetch failed|ECONNREFUSED|timeout/i.test(msg)) {
      return { ok: false, occupied: false, reason: 'unreachable' };
    }
    return { ok: false, occupied: false, reason: msg };
  }
}

function launchDebugBrowser(config, browserExe) {
  if (!fs.existsSync(config.userDataDir)) {
    fs.mkdirSync(config.userDataDir, { recursive: true });
  }

  const args = [
    `--remote-debugging-port=${config.devtoolsPort}`,
    `--remote-debugging-address=${config.devtoolsHost}`,
    `--user-data-dir=${config.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    ...config.urls,
  ];

  const child = spawn(browserExe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

async function waitForDevTools(config) {
  const startedAt = Date.now();
  let lastPrintAt = 0;

  while (Date.now() - startedAt < config.waitTimeoutMs) {
    const probe = await probeDevTools(config);
    if (probe.ok) {
      return { ok: true, devtoolsAccessible: true, pageCount: probe.pageCount, list: probe.list };
    }

    if (probe.occupied && probe.reason === 'not_chrome_devtools') {
      return { ok: false, devtoolsAccessible: false, reason: 'port_occupied', occupied: true };
    }

    const now = Date.now();
    if (now - lastPrintAt >= config.sameErrorPrintIntervalMs || lastPrintAt === 0) {
      println(`[千帆] 等待 DevTools ${config.devtoolsPort} 就绪...`);
      lastPrintAt = now;
    }

    await sleep(config.checkIntervalMs);
  }

  return { ok: false, devtoolsAccessible: false, reason: 'timeout' };
}

function printDevToolsUnreachable(config, attachResult = {}) {
  const port = config.devtoolsPort;
  const reason = attachResult.reason || 'unreachable';

  if (['client_not_found', 'launch_failed', 'timeout'].includes(reason)) {
    println('[千帆] 千帆监听未接入');
    return;
  }

  println(`[千帆] DevTools ${port}：不可访问`);
  println('[千帆] 千帆监听未接入');

  if (config.mode === 'launch_client') {
    println('[原因] 千帆客服工作台可能未以调试端口启动，或调试参数未生效');
    println('[操作] 请确认千帆客服工作台能正常启动');
    return;
  }

  println(
    `[原因] 当前千帆客户端可能不是以调试端口 ${port} 启动，程序无法注入监听`
  );
  println(
    '[操作] 请使用带调试端口的方式启动千帆客户端，或把 qianfanDebug.mode 改为 launch_browser 后让程序启动调试浏览器'
  );
  println('[说明] 你已登录千帆不代表程序能监听，监听需要 DevTools 调试端口');
}

function printDevToolsPortOccupied(config) {
  const port = config.devtoolsPort;
  println(`[千帆] DevTools ${port}：不可访问`);
  println('[千帆] 千帆监听未接入');
  println(`[原因] ${port} 端口被其他程序占用，返回内容不是 Chrome DevTools`);
  println(`[操作] 请关闭占用 ${port} 的程序，或修改 config.wxbot-new.json 里的 devtoolsPort`);
}

function printShopAttachReport(config, attachResult) {
  const port = config.devtoolsPort;

  if (!attachResult.devtoolsAccessible) {
    if (attachResult.reason === 'port_occupied') {
      printDevToolsPortOccupied(config);
    } else {
      printDevToolsUnreachable(config, attachResult);
    }
    return {
      ...attachResult,
      shopReport: null,
      canStartListener: false,
    };
  }

  println(`[千帆] DevTools ${port}：可访问`);
  println('[千帆] 正在扫描千帆页面 / 店铺工作台...');

  const shopReport = detectQianfanShopPages(getPageTargets(attachResult.list), {
    expectedShopCount: config.expectedShopCount,
  });

  if (shopReport.detectedShopCount === 0) {
    println('[千帆] 未检测到店铺工作台页面');
    println(`[操作] 请在千帆客服工作台中打开 ${config.expectedShopCount} 个店铺工作台`);
    if (shopReport.relatedPageCount > 0) {
      println(`[提示] 已发现 ${shopReport.relatedPageCount} 个千帆相关页面，但尚无「xxx-工作台」页面`);
    }
    return {
      ...attachResult,
      shopReport,
      canStartListener: false,
    };
  }

  const { expectedShopCount, detectedShopCount, shops } = shopReport;
  if (detectedShopCount >= expectedShopCount) {
    println(`[千帆] 接入成功：已检测到 ${detectedShopCount} 个店铺工作台`);
  } else {
    println(`[千帆] 接入部分成功：检测到 ${detectedShopCount} / ${expectedShopCount} 个店铺工作台`);
  }

  shops.forEach((shop, i) => {
    println(`[千帆] 店铺 ${i + 1}：${shop.shopTitle}`);
  });

  if (detectedShopCount < expectedShopCount) {
    println('[提示] 请在千帆客服工作台里打开剩余店铺工作台');
  }

  return {
    ...attachResult,
    shopReport,
    canStartListener: true,
  };
}

/**
 * 接入现有千帆 DevTools；仅在 launch_browser / autoLaunchBrowserWhenMissing 时启动浏览器
 * @param {object} cfg qianfanDebug 配置
 */
async function attachQianfanDevTools(cfg) {
  const config = resolveDebugConfig(cfg);

  if (!config.enabled) {
    return { ok: false, reason: 'disabled', devtoolsAccessible: false };
  }

  const firstProbe = await probeDevTools(config);
  if (firstProbe.ok) {
    return {
      ok: true,
      devtoolsAccessible: true,
      alreadyRunning: true,
      pageCount: firstProbe.pageCount,
      list: firstProbe.list,
    };
  }

  if (firstProbe.occupied) {
    return {
      ok: false,
      devtoolsAccessible: false,
      occupied: true,
      reason: 'port_occupied',
    };
  }

  if (!shouldAutoLaunchBrowser(config)) {
    return {
      ok: false,
      devtoolsAccessible: false,
      reason: 'unreachable',
    };
  }

  const browserExe = findBrowserExe(config);
  if (!browserExe) {
    return { ok: false, devtoolsAccessible: false, reason: 'browser_not_found' };
  }

  println(`[千帆] 正在启动调试浏览器，端口：${config.devtoolsPort}`);
  println('[千帆] 如果弹出千帆页面，请登录并打开店铺工作台');
  launchDebugBrowser(config, browserExe);

  return waitForDevTools(config);
}

/**
 * 扫描千帆店铺并打印接入报告（不启动客户端/浏览器）
 */
async function runQianfanShopAttachReport(cfg) {
  const config = resolveDebugConfig(cfg);
  const { probeDevTools: probeClient } = require('./qianfan-client-launcher');
  const probe = await probeClient({
    devtoolsPort: config.devtoolsPort,
    devtoolsHost: config.devtoolsHost,
  });

  if (!probe.ok) {
    return printShopAttachReport(config, {
      devtoolsAccessible: false,
      reason: probe.reason,
      occupied: probe.occupied,
    });
  }

  return printShopAttachReport(config, {
    devtoolsAccessible: true,
    list: probe.list,
    pageCount: probe.pageCount,
  });
}

/**
 * 接入千帆并打印自检报告（兼容旧调用；launch_client 模式下请先 ensureQianfanClientDebugReady）
 */
async function runQianfanAttachCheck(cfg) {
  const config = resolveDebugConfig(cfg);

  if (config.mode === 'launch_client' && config.autoLaunchQianfanClientWhenMissing) {
    const { ensureQianfanClientDebugReady } = require('./qianfan-client-launcher');
    const clientResult = await ensureQianfanClientDebugReady(cfg);
    if (!clientResult.devtoolsAccessible) {
      return printShopAttachReport(config, clientResult);
    }
    return runQianfanShopAttachReport(cfg);
  }

  const attachResult = await attachQianfanDevTools(cfg);
  return printShopAttachReport(config, attachResult);
}

/** @deprecated 请使用 runQianfanAttachCheck / attachQianfanDevTools */
async function ensureQianfanDebugBrowser(cfg) {
  return attachQianfanDevTools(cfg);
}

module.exports = {
  attachQianfanDevTools,
  runQianfanAttachCheck,
  runQianfanShopAttachReport,
  ensureQianfanDebugBrowser,
  probeDevTools,
  resolveDebugConfig,
  printShopAttachReport,
};
