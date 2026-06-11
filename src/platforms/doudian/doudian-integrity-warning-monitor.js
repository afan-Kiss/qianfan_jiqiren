const INTEGRITY_PATTERNS = [
  '客户端被篡改',
  '环境异常',
  '客户端异常',
  '文件被修改',
  '完整性校验失败',
];

const DOUDIAN_INTEGRITY_EVENT = 'doudian.client.integrity_warning';

function maskIntegrityText(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (s.length <= 24) return s;
  return `${s.slice(0, 20)}...`;
}

function detectIntegrityWarning(text) {
  const s = String(text || '');
  if (!s) return null;
  for (const pattern of INTEGRITY_PATTERNS) {
    if (s.includes(pattern)) {
      return {
        detected: true,
        text: maskIntegrityText(s),
        pattern,
        source: 'stdout',
        action: 'record_only',
      };
    }
  }
  return null;
}

function scanStdoutLine(line, existing = []) {
  const hit = detectIntegrityWarning(line);
  if (!hit) return existing;
  return appendIntegrityWarning(existing, hit);
}

function scanWindowTitle(title, existing = []) {
  const s = String(title || '').trim();
  if (!s) return existing;
  for (const pattern of INTEGRITY_PATTERNS) {
    if (!s.includes(pattern)) continue;
    return appendIntegrityWarning(existing, {
      detected: true,
      text: maskIntegrityText(s),
      pattern,
      source: 'window_title',
      action: 'record_only',
    });
  }
  return existing;
}

function scanDomText(text, existing = []) {
  const hit = detectIntegrityWarning(text);
  if (!hit) return existing;
  return appendIntegrityWarning(existing, { ...hit, source: 'dom' });
}

function appendIntegrityWarning(existing, warning) {
  const list = Array.isArray(existing) ? [...existing] : [];
  const key = `${warning.source}|${warning.pattern}|${warning.text}`;
  if (list.some((w) => `${w.source}|${w.pattern}|${w.text}` === key)) {
    return list;
  }
  list.push({
    ...warning,
    at: Date.now(),
  });
  return list;
}

function createIntegrityWarningEnvelope(warning) {
  return {
    type: DOUDIAN_INTEGRITY_EVENT,
    timestamp: Date.now(),
    payload: {
      detected: Boolean(warning?.detected),
      text: warning?.text || '',
      source: warning?.source || 'stdout',
      action: 'record_only',
      pattern: warning?.pattern || '',
    },
  };
}

function applyIntegrityWarningsToReport(report, warnings) {
  const list = Array.isArray(warnings) ? warnings : [];
  report.integrityWarnings = list;
  report.integrityWarningDetected = list.length > 0;
  return report;
}

module.exports = {
  INTEGRITY_PATTERNS,
  DOUDIAN_INTEGRITY_EVENT,
  detectIntegrityWarning,
  scanStdoutLine,
  scanWindowTitle,
  scanDomText,
  appendIntegrityWarning,
  createIntegrityWarningEnvelope,
  applyIntegrityWarningsToReport,
};
