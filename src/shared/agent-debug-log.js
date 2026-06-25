/**
 * Debug session logging (session fbcb3f). Remove after verification.
 */
const fs = require('fs');
const path = require('path');

const SESSION_ID = 'fbcb3f';
const ENDPOINT = 'http://127.0.0.1:7692/ingest/f57e956c-2e7c-407e-a173-57c6742adb5b';

function resolveLogPath() {
  try {
    const config = require('../wechat/wxbot-new-config');
    if (config?.root) return path.join(config.root, 'debug-fbcb3f.log');
  } catch {
    // ignore
  }
  return path.join(__dirname, '..', '..', 'debug-fbcb3f.log');
}

function agentDebugLog({ location, message, data = {}, hypothesisId = '', runId = 'pre-fix' }) {
  const payload = {
    sessionId: SESSION_ID,
    location,
    message,
    data,
    hypothesisId,
    runId,
    timestamp: Date.now(),
  };
  const logPath = resolveLogPath();
  // #region agent log
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': SESSION_ID },
    body: JSON.stringify(payload),
  }).catch(() => {});
  try {
    fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch {
    // ignore
  }
  // #endregion
}

module.exports = { agentDebugLog };
