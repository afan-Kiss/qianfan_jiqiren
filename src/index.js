const { getDoudianRuntime } = require('./platforms/doudian');
const { runStartupOrchestrator } = require('./services/app/startup-orchestrator');
const { getConversationContext } = require('./services/history/conversation-context');
const { ensureDebugClientReady } = require('./services/runtime/ensure-debug-client-ready');

module.exports = {
  getDoudianRuntime,
  doudian: require('./platforms/doudian'),
  runStartupOrchestrator,
  getConversationContext,
  ensureDebugClientReady,
};
