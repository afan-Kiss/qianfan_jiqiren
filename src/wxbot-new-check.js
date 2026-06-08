/**
 * 检测 wxbot-new 微信注入状态
 * 用法：npm run wx:check
 */
const { checkWxbotHealth, formatCheckLines } = require('./wxbot-new-health');
const config = require('./wechat/wxbot-new-config');
const { println } = require('./utils');

async function main() {
  println('');
  println('======== 微信注入检测 ========');
  println(`baseUrl: ${config.baseUrl}`);
  println(`startupMode: ${config.startupMode || 'manual_wxbot_exe'}`);
  println('说明：请先运行 wxbot.exe，由 wxbot 拉起微信并扫码登录');
  println('');

  const report = await checkWxbotHealth();
  for (const line of formatCheckLines(report)) {
    println(line);
  }

  println('');
  if (report.ok) {
    println('检测通过，可进行 npm run wx:test-send 与 npm run wx:callback');
    process.exit(0);
  }
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    println(`[微信] 检测异常：${err.message || err}`);
    process.exit(1);
  });
}
