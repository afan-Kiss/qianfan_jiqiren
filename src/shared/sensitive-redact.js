const SENSITIVE_KEYS = new Set([
  'cookie',
  'cookies',
  'authorization',
  'token',
  'access_token',
  'refresh_token',
  'sessionid',
  'session_id',
  'password',
  'passwd',
  'phone',
  'mobile',
  'idcard',
  'id_card',
  '身份证',
  '手机号',
]);

const SENSITIVE_PATTERNS = [
  /cookie/i,
  /authorization/i,
  /token/i,
  /bearer\s+/i,
  /sessionid/i,
];

function isSensitiveKey(key) {
  const k = String(key || '').toLowerCase();
  if (SENSITIVE_KEYS.has(k)) return true;
  return SENSITIVE_PATTERNS.some((re) => re.test(k));
}

function redactValue(value, depth = 0) {
  if (depth > 6) return '[max_depth]';
  if (value == null) return value;
  if (typeof value === 'string') {
    if (SENSITIVE_PATTERNS.some((re) => re.test(value))) return '[redacted]';
    return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? '[redacted]' : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

function redactPayload(payload, enabled = true) {
  if (!enabled || payload == null) return payload;
  try {
    return redactValue(payload);
  } catch {
    return { error: 'redact_failed' };
  }
}

module.exports = {
  isSensitiveKey,
  redactPayload,
  SENSITIVE_KEYS,
};
