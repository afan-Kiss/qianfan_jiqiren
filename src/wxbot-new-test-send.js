/**
 * wxbot-new 测试发送
 * 用法：npm run wx:test-send
 */
const { checkWxbotHealth } = require('./wxbot-new-health');
const config = require('./wechat/wxbot-new-config');
const { println } = require('./utils');
const { fetchWithTimeout } = require('./fetch-timeout');

async function sendText(wxid, content) {
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
      body: JSON.stringify({ wxid, content }),
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
    throw new Error(body?.message || text || `HTTP ${res.status}`);
  }
}

async function main() {
  println('');
  println('======== 微信测试发送 ========');

  const report = await checkWxbotHealth();
  if (!report.ok) {
    println('[错误] 注入状态未就绪，请先运行 一键启动微信机器人.bat');
    process.exit(1);
  }

  const target = config.testSendWxid || config.readyNotifyWxid || 'filehelper';
  const content = `【千帆客服台机器人】测试消息 ${new Date().toLocaleString('zh-CN')}`;

  if (config.dryRun) {
    println(`[DRY_RUN] 将发送到 ${target}：${content}`);
    process.exit(0);
  }

  await sendText(target, content);
  println(`[微信] 已发送到 ${target}`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    println(`[微信] 测试异常：${err.message || err}`);
    process.exit(1);
  });
}
