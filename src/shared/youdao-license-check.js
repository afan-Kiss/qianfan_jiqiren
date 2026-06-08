const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('../fetch-timeout');
const { resolveDataDir } = require('./app-root');

const YOUDAO_SHARE_KEY = '59fb59203600e841c444d96bad36d3e4';
const YOUDAO_SHARE_API = `https://note.youdao.com/yws/api/personal/share?method=get&shareKey=${YOUDAO_SHARE_KEY}`;
const RELAY_SWITCH_KEY = '千帆中转';
const BLOCKED_MESSAGE = '软件不可用，请联系17364583794 同V';
const VERIFY_FAIL_MESSAGE = '无法验证软件授权，请检查网络后重试。联系17364583794 同V';
const FETCH_TIMEOUT_MS = 12000;
const LICENSE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const LICENSE_CACHE_FILE = path.join(resolveDataDir(), 'youdao-license-cache.json');

function readLicenseCache() {
  if (!fs.existsSync(LICENSE_CACHE_FILE)) return null;
  try {
    const cached = JSON.parse(fs.readFileSync(LICENSE_CACHE_FILE, 'utf8'));
    if (!cached?.ok || !cached.cachedAt) return null;
    if (Date.now() - Number(cached.cachedAt) > LICENSE_CACHE_TTL_MS) return null;
    return cached;
  } catch {
    return null;
  }
}

function writeLicenseCache(result) {
  try {
    const dir = path.dirname(LICENSE_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      LICENSE_CACHE_FILE,
      `${JSON.stringify({
        ok: true,
        cachedAt: Date.now(),
        states: result.states || {},
        relayState: result.relayState || '开',
      })}\n`,
      'utf8',
    );
  } catch {
    // ignore cache write failures
  }
}

function parseSwitchStates(text) {
  const raw = String(text || '');
  const states = {};
  const bracketRe = /\[([^\]]+)\]=([^\s\[\]]+)/g;
  let match = bracketRe.exec(raw);
  while (match) {
    states[match[1].trim()] = match[2].trim();
    match = bracketRe.exec(raw);
  }
  const plainRe = /([^\s\[\]=]+)=([开关])/g;
  match = plainRe.exec(raw);
  while (match) {
    const key = match[1].trim();
    if (!states[key]) states[key] = match[2].trim();
    match = plainRe.exec(raw);
  }
  return states;
}

function extractNoteText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const entry = payload.entry || {};
  const parts = [
    entry.summary,
    entry.name,
    payload.name,
    payload.summary,
  ];
  return parts.filter(Boolean).join(' ');
}

function isRelaySwitchOff(states) {
  const value = String(states[RELAY_SWITCH_KEY] || '').trim();
  return value === '关';
}

async function fetchYoudaoSharePayload(fetchFn = fetchWithTimeout) {
  const res = await fetchFn(YOUDAO_SHARE_API, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
    },
  }, FETCH_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`有道云笔记请求失败: HTTP ${res.status}`);
  }
  return res.json();
}

async function verifyQianfanRelayLicense(options = {}) {
  if (process.env.QIANFAN_SKIP_LICENSE_CHECK === '1') {
    return { ok: true, skipped: true, reason: 'env_skip' };
  }

  const fetchFn = options.fetchFn || fetchWithTimeout;
  try {
    const payload = await fetchYoudaoSharePayload(fetchFn);
    const noteText = extractNoteText(payload);
    let states = parseSwitchStates(noteText);
    if (!Object.keys(states).length) {
      states = parseSwitchStates(JSON.stringify(payload));
    }
    if (!Object.keys(states).length) {
      const cached = readLicenseCache();
      if (cached) {
        return {
          ok: true,
          reason: 'cache_ok',
          cached: true,
          states: cached.states,
          relayState: cached.relayState,
          noteText,
        };
      }
      return {
        ok: false,
        reason: 'parse_empty',
        message: VERIFY_FAIL_MESSAGE,
        noteText,
      };
    }
    if (isRelaySwitchOff(states)) {
      return {
        ok: false,
        reason: 'relay_off',
        message: BLOCKED_MESSAGE,
        states,
        noteText,
      };
    }
    const success = {
      ok: true,
      reason: 'relay_on',
      states,
      noteText,
      relayState: states[RELAY_SWITCH_KEY] || '开',
    };
    writeLicenseCache(success);
    return success;
  } catch (err) {
    const cached = readLicenseCache();
    if (cached) {
      return {
        ok: true,
        reason: 'cache_ok',
        cached: true,
        states: cached.states,
        relayState: cached.relayState,
        error: err?.message || String(err),
      };
    }
    return {
      ok: false,
      reason: 'fetch_failed',
      message: VERIFY_FAIL_MESSAGE,
      error: err?.message || String(err),
    };
  }
}

module.exports = {
  YOUDAO_SHARE_KEY,
  YOUDAO_SHARE_API,
  RELAY_SWITCH_KEY,
  BLOCKED_MESSAGE,
  parseSwitchStates,
  extractNoteText,
  fetchYoudaoSharePayload,
  verifyQianfanRelayLicense,
};
