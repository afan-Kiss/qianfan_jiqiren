const { getDoudianRuntime, DoudianRuntime } = require('./doudian-runtime');
const { getDoudianWsServer, DoudianWsServer } = require('./doudian-ws-server');
const { probeCdpRoute, scanCdpPorts, buildCdpPortList } = require('./doudian-cdp-probe');
const { detectDoudianProcesses } = require('./doudian-process-detector');
const { findDoudianPages, classifyPagePlatform } = require('./doudian-page-finder');
const { injectDoudianBridge, findAndInject } = require('./doudian-injector');
const { analyzeDoudianInstall } = require('./doudian-asar-analyzer');
const { applyAsarPatch, rollbackAsarPatch, getPatchStatus, verifyAsarPatch } = require('./doudian-asar-patcher');
const { tryAsarInject, analyzeInstallRoute } = require('./doudian-asar-injector');
const { DoudianMessageListener } = require('./doudian-message-listener');
const { DoudianMessageSender } = require('./doudian-message-sender');
const { DoudianAftersaleListener } = require('./doudian-aftersale-listener');
const { DoudianOrderContext } = require('./doudian-order-context');
const { DoudianDedupe } = require('./doudian-dedupe');
const {
  PLATFORM,
  BRIDGE_EVENTS,
  DOUDIAN_EVENTS,
  SEND_TASK_EVENT,
  INJECTION_ROUTES,
  createEnvelope,
  createRuntimeStatus,
} = require('./doudian-types');

module.exports = {
  PLATFORM,
  BRIDGE_EVENTS,
  DOUDIAN_EVENTS,
  SEND_TASK_EVENT,
  createEnvelope,
  INJECTION_ROUTES,
  createRuntimeStatus,
  getDoudianRuntime,
  DoudianRuntime,
  getDoudianWsServer,
  DoudianWsServer,
  probeCdpRoute,
  scanCdpPorts,
  buildCdpPortList,
  detectDoudianProcesses,
  findDoudianPages,
  classifyPagePlatform,
  injectDoudianBridge,
  findAndInject,
  analyzeDoudianInstall,
  applyAsarPatch,
  rollbackAsarPatch,
  getPatchStatus,
  verifyAsarPatch,
  tryAsarInject,
  analyzeInstallRoute,
  DoudianMessageListener,
  DoudianMessageSender,
  DoudianAftersaleListener,
  DoudianOrderContext,
  DoudianDedupe,
};
