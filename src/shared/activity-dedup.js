const { buildActivityDedupKey: buildDisplayDedupKey } = require('./activity-log');

function buildActivityDedupKey(entry = {}) {
  return buildDisplayDedupKey(entry);
}

function createActivityDedup(windowMs = 3000) {
  const seen = new Map();

  function shouldShow(key, now = Date.now()) {
    const normalized = String(key || '').trim();
    if (!normalized) return true;
    const last = seen.get(normalized);
    if (last === undefined) {
      seen.set(normalized, now);
      return true;
    }
    if (now - last < windowMs) return false;
    seen.set(normalized, now);
    return true;
  }

  function reset() {
    seen.clear();
  }

  return { shouldShow, reset, buildActivityDedupKey };
}

module.exports = {
  createActivityDedup,
  buildActivityDedupKey,
};
