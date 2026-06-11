const { bridgeLog } = require('../../shared/bridge-log');

function buildBridgeHealth(state = {}) {
  const health = {
    devtoolsPortOk: Boolean(state.devtoolsPortOk),
    devtoolsPort: state.devtoolsPort || 0,
    cdpConnected: Boolean(state.cdpConnected),
    targetCount: Number(state.targetCount || 0),
    injectedCount: Number(state.injectedCount || 0),
    wsConnectionCount: Number(state.wsConnectionCount || 0),
    lastFrameAt: state.lastFrameAt || '',
    lastBusinessAt: state.lastBusinessAt || '',
    lastError: state.lastError || '',
    frameCount: Number(state.frameCount || 0),
    businessCount: Number(state.businessCount || 0),
    targets: state.targets || [],
    connections: state.connections || [],
    errors: state.errors || [],
    updatedAt: new Date().toISOString(),
  };

  bridgeLog('[BRIDGE_HEALTH]', `port=${health.devtoolsPortOk} cdp=${health.cdpConnected} targets=${health.targetCount} frames=${health.frameCount}`);
  return health;
}

function healthSummaryLines(health) {
  return [
    `DevTools端口: ${health.devtoolsPortOk ? '可用' : '不可用'} (${health.devtoolsPort || '-'})`,
    `CDP连接: ${health.cdpConnected ? '是' : '否'}`,
    `Target数: ${health.targetCount}`,
    `注入成功: ${health.injectedCount}`,
    `WebSocket连接: ${health.wsConnectionCount}`,
    `帧总数: ${health.frameCount}`,
    `业务消息: ${health.businessCount}`,
    `最近帧: ${health.lastFrameAt || '-'}`,
    `最近业务消息: ${health.lastBusinessAt || '-'}`,
    `最近错误: ${health.lastError || '-'}`,
  ];
}

module.exports = {
  buildBridgeHealth,
  healthSummaryLines,
};
