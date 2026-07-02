#!/usr/bin/env node
/**
 * 查看协议抓包开关与统计
 */
const { getProtocolTapStatus } = require('../src/capture/qianfan-protocol-tap');

const status = getProtocolTapStatus();
console.log(JSON.stringify(status, null, 2));
if (!status.enabled) {
  console.log('\n开启方式：config.wxbot-new.json → qianfanDebug.protocolTapEnabled=true');
  console.log('或启动前设置环境变量 QIANFAN_PROTOCOL_TAP=1');
}
