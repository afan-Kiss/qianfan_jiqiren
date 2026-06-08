/**
 * 千帆客服台机器人 - wxbot-new 一键启动
 * 微信底座 + 千帆客服工作台调试模式 + 买家消息微信通知
 */
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const config = require('./wechat/wxbot-new-config');
const { checkWxbotHealth } = require('./wxbot-new-health');
const { startWxbotCallbackServer } = require('./wxbot-new-callback-server');
const { createWechatToQianfanDispatcher } = require('./wechat-to-qianfan-reply');
const { syncWxbotCallbackConfig } = require('./wxbot-new-api');
const { ensureQianfanClientDebugReady } = require('./qianfan-client-launcher');
const { runQianfanShopAttachReport } = require('./qianfan-debug-launcher');
const { runStartupLogMaintenance } = require('./log-maintenance');
const { shouldLogCallback } = require('./wxbot-new-callback-log');
const { println } = require('./utils');
const { fetchWithTimeout } = require('./fetch-timeout');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function printBanner() {
  println('');
  println('====================================');
  println('千帆客服台机器人 - 微信一键启动');
  println('====================================');
  println('当前阶段：微信底座 + 千帆买家消息通知 + 二号引用回复千帆');
  println('操作：微信扫码登录；千帆将自动以调试模式启动');
  println('====================================');
  println('');
}

function ensureWxbotExe() {
  if (!fs.existsSync(config.wxbotExe)) {
    println(`[错误] 未找到 wxbot.exe：${config.wxbotExe}`);
    process.exit(1);
  }
}

function killExistingWechat() {
  println('[提示] 为保证注入稳定，建议提前关闭所有微信。');
  if (!config.oneClick.autoKillExistingWechat) return;

  let killed = false;
  for (const proc of ['Weixin.exe', 'WeChat.exe', 'wxbot.exe']) {
    try {
      execSync(`taskkill /F /IM ${proc}`, { stdio: 'ignore' });
      killed = true;
    } catch {
      // ignore
    }
  }
  if (killed) {
    println('[微信] 已尝试关闭旧微信 / wxbot 进程');
  } else {
    println('[微信] 未发现已运行微信，继续启动');
  }
}

function startWxbotExe() {
  const wxbotDir = config.wxbotRuntimeDir;
  spawn(config.wxbotExe, [], {
    cwd: wxbotDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  }).unref();

  println('[微信] wxbot.exe 已启动');
  println('[操作] 如果微信窗口弹出，请扫码登录');
}

async function waitForInjection() {
  const interval = config.oneClick.healthCheckIntervalMs || 2000;
  const sameErrGap = config.oneClick.sameErrorPrintIntervalMs || 10000;
  let lastPrintAt = 0;
  let lastReason = '';

  while (true) {
    const report = await checkWxbotHealth();
    if (report.ok) return report;
    if (report.wrongLoginWxid) return report;

    const now = Date.now();
    const reason = report.brief || report.reason || '等待扫码/注入中';
    const shouldPrint =
      now - lastPrintAt >= sameErrGap || reason !== lastReason || lastPrintAt === 0;

    if (shouldPrint) {
      println('[检测] 等待扫码/注入中...');
      lastPrintAt = now;
      lastReason = reason;
    }

    await sleep(interval);
  }
}

function printWrongLoginError(report) {
  const robot = config.robotAccount;
  const currentParts = [];
  if (report.nickname) currentParts.push(report.nickname);
  if (report.wxid) currentParts.push(report.wxid);
  const current = currentParts.join(' ') || '未知';

  println('[错误] 当前电脑登录微信不是机器人号');
  println(`[当前] ${current}`);
  println(`[要求] ${robot.wxid} / ${robot.wechatNo}`);
  println('[操作] 请退出当前微信，重新运行一键 BAT，让 wxbot.exe 拉起正确的微信扫码登录');
}

function printLoginIdentityOk(report) {
  const robot = config.robotAccount;
  println(
    `[微信] 登录号校验：通过，当前为机器人号 ${robot.name} ${robot.wechatNo}`
  );
}

function printConfigSummary() {
  const robot = config.robotAccount;
  const receiver = config.notifyReceiverAccount;
  const notifyTarget =
    config.notifyTargets.find((a) => a.wxid === receiver.wxid) || config.notifyTargets[0];

  println(`[配置] 机器人登录号：${robot.name} ${robot.wechatNo} ${robot.wxid}`);
  println(
    `[配置] 通知接收号：${notifyTarget.name} ${notifyTarget.wechatNo} ${notifyTarget.wxid}`
  );
  println('[链路] 千帆买家消息 -> 机器人号 -> 通知接收号');
  println('[链路] 接收号引用回复 -> 机器人号接收 -> 后续回复千帆');
}

async function sendReadyMessage() {
  const url = `${config.baseUrl.replace(/\/$/, '')}/api/wechat/send-text`;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (config.username && config.password) {
    headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  }

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        wxid: config.readyNotifyWxid || 'filehelper',
        content: config.readyNotifyText,
      }),
    },
    8000
  );

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!res.ok || body?.code !== 0) {
    const msg = body?.message || text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
}

function printReadySummary(report) {
  const name = report.nickname ? `${report.nickname} ` : '';
  println(`[微信] wxbot-new API：正常`);
  println(`[微信] 注入状态：正常`);
  println(`[微信] 当前登录：${name}${report.wxid}`);
}

async function startQianfanListener(qianfanAttachResult, notificationsEnabled) {
  if (!notificationsEnabled) {
    println('[千帆] 登录号校验未通过，千帆监听与微信通知已跳过');
    return;
  }

  if (!qianfanAttachResult?.canStartListener) {
    println('[提示] 微信底座仍在运行；千帆未接入时不发送买家通知');
    return;
  }

  try {
    const { startQianfanMessageListener, releaseSeenBuyerMessage } = require('./qianfan-message-listener');
    const { createQianfanWechatNotifier } = require('./qianfan-wechat-notifier');
    const notifier = createQianfanWechatNotifier({
      enabled: true,
      releaseSeenBuyerMessage,
    });
    await startQianfanMessageListener({
      devtoolsPort: config.qianfanDebug.devtoolsPort,
      devtoolsHost: config.qianfanDebug.devtoolsHost,
      expectedShopCount: config.qianfanDebug.expectedShopCount,
      shopReport: qianfanAttachResult.shopReport,
      pages: qianfanAttachResult.shopReport?.shops,
      onBuyerMessage: (message, options) => notifier.handleBuyerMessage(message, options),
    });
    println('[千帆] 监听已启动，等待买家消息...');
  } catch (err) {
    println(`[错误] 千帆监听启动失败：${err.message || err}`);
    println('[提示] 微信底座仍在运行，可继续接收微信回调');
  }
}

async function main() {
  printBanner();
  runStartupLogMaintenance();
  ensureWxbotExe();
  killExistingWechat();

  const qianfanCfg = { ...config.qianfanDebug, root: config.root };
  const qianfanClientPromise = ensureQianfanClientDebugReady(qianfanCfg);

  const qianfanReplyDispatcher = createWechatToQianfanDispatcher();
  const callbackState = await startWxbotCallbackServer({
    onCallback: async (line, parsed, body) => {
      if (shouldLogCallback(parsed)) println(line);
      await qianfanReplyDispatcher.handleCallback(parsed, body);
    },
    silent: false,
    forcePort: true,
  });

  if (callbackState.alreadyRunning) {
    println('[错误] 8787 回调端口仍被占用，请关闭旧 Node 窗口后重试');
    process.exit(1);
  }

  startWxbotExe();

  const [report] = await Promise.all([waitForInjection(), qianfanClientPromise]);

  if (report.wrongLoginWxid) {
    printWrongLoginError(report);
    println('');
    println('[运行] 微信回调服务仍在运行，但千帆监听与通知已停止');
    println('[运行] 请退出错误微信后重新双击一键 BAT');
    println('[运行] 按 Ctrl+C 可退出');
    println('');
    await new Promise(() => {});
    return;
  }

  const identityOk = report.wxid === config.loginBotWxid;
  printLoginIdentityOk(report);
  printConfigSummary();

  try {
    await syncWxbotCallbackConfig();
    println('[回调] 已同步 wxbot callback_urls');
  } catch (err) {
    println(`[警告] 同步 wxbot 回调配置失败：${err.message || err}`);
  }

  printReadySummary(report);

  try {
    await sendReadyMessage();
    println('[微信] 已给文件传输助手发送准备就绪消息');
    println('[就绪] 微信机器人底座已准备妥当');
  } catch (err) {
    println(`[警告] 文件传输助手测试消息发送失败：${err.message || err}`);
    println('[提示] 但注入状态已正常，可继续观察回调');
    println('[就绪] 微信机器人底座已准备妥当');
  }

  println('');
  const qianfanAttachResult = await runQianfanShopAttachReport(qianfanCfg);
  await startQianfanListener(qianfanAttachResult, identityOk);

  println('');
  println('[运行] 保持本窗口打开，收到微信消息将在此打印');
  println('[运行] 请在 PC 微信窗口收发消息（手机端消息需同步到 PC 才会回调）');
  println('[运行] 千帆由客服工作台自动以调试模式启动，不会打开浏览器');
  println('[运行] 按 Ctrl+C 可退出');
  println('');

  await new Promise(() => {});
}

process.on('unhandledRejection', (err) => {
  println(`[错误] 未捕获异常（程序继续运行）：${err?.message || err}`);
});

process.on('uncaughtException', (err) => {
  println(`[错误] 未捕获异常（程序继续运行）：${err?.message || err}`);
});

main().catch((err) => {
  println(`[错误] 一键启动失败：${err.message || err}`);
  process.exit(1);
});
