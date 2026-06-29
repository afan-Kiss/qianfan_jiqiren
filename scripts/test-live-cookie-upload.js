/**
 * 联调：从当前千帆 DevTools 采集 Cookie 并上传到总控台（不打印完整 Cookie）
 */
const CDP = require('chrome-remote-interface');
const config = require('../src/wechat/wxbot-new-config');
const { detectQianfanShopPages } = require('../src/page-finder');
const { getPageTargets, fetchDevToolsJsonList } = require('../src/devtools-list');
const { registerQianfanWsBridge } = require('../src/qianfan-ws-bridge');
const {
  collectQianfanCookies,
  uploadCookieToControlCenter,
  hashPrefix,
  getControlConfig,
} = require('../src/qianfan-cookie-collector');
const { println } = require('../src/utils');

async function main() {
  const cc = getControlConfig();
  if (!cc.enabled) {
    console.error('[live-cookie] controlCenter 未启用或缺少 serviceToken');
    process.exit(1);
  }

  const port = config.qianfanDebug?.devtoolsPort || 9322;
  const host = config.qianfanDebug?.devtoolsHost || '127.0.0.1';
  const list = await fetchDevToolsJsonList(port, host);
  const report = detectQianfanShopPages(getPageTargets(list), { expectedShopCount: 4 });
  if (!report.shops.length) {
    console.error('[live-cookie] 未找到千帆工作台页面');
    process.exit(1);
  }

  console.log(`[live-cookie] 发现 ${report.shops.length} 个店铺页面`);
  let uploaded = 0;

  for (const page of report.shops) {
    const shop = page.shopTitle || page.pageTitle;
    let client;
    try {
      client = await CDP({ target: page.webSocketDebuggerUrl });
      const bridge = await registerQianfanWsBridge(page, client);
      const collected = await collectQianfanCookies(bridge);
      if (!collected) {
        console.log(`[live-cookie] ${shop} 未采集到 Cookie`);
        continue;
      }
      console.log(
        `[live-cookie] ${shop} hash=${hashPrefix(collected.cookieHash)} len=${collected.cookie.length}`
      );
      const result = await uploadCookieToControlCenter(collected);
      if (result.ok) {
        uploaded += 1;
        console.log(
          `[live-cookie] ${shop} 上传成功 unchanged=${Boolean(result.data?.unchanged)}`
        );
      } else {
        console.log(`[live-cookie] ${shop} 上传失败 ${result.error || result.reason}`);
      }
    } catch (err) {
      console.log(`[live-cookie] ${shop} 异常 ${err.message || err}`);
    } finally {
      if (client) {
        try {
          await client.close();
        } catch {
          // ignore
        }
      }
    }
  }

  console.log(`[live-cookie] 完成 uploaded=${uploaded}/${report.shops.length}`);
  process.exit(uploaded > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[live-cookie] failed', err.message || err);
  process.exit(1);
});
