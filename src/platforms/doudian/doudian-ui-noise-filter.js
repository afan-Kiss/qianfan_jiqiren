const UI_NOISE_EXACT = new Set([
  '在线',
  '三方',
  '商家后台',
  'AI智能客服',
  '挽单方案配置',
  '当前会话',
  '最近联系',
  '列表设置',
  '等待时长',
  '已分组',
  '首页',
  '接待',
  '通知',
  '待发货',
  '售后',
  '暂无会话中用户',
  '请选择会话',
  '与消费者聊天',
  '您今日暂无接待数据',
  '抖店',
  '飞鸽客服系统',
  '加载中...',
  '加载中',
  '实时',
  '查看',
  '设置',
  '搜索',
]);

const UI_NOISE_PARTIAL = [
  'AI智能客服',
  '挽单方案配置',
  '开启场景后',
  '给智能客服更多授权',
  '降低转人工进线',
  '当前会话',
  '最近联系',
  '商家后台',
  '列表设置',
  '等待时长',
  '暂无会话',
  '请选择会话',
  '挽单工具',
  '售后挽单',
  '加载中',
  '智能客服',
];

const INVALID_SHOP_NAMES = new Set(['首页', '抖店', '飞鸽客服系统', '消息', '客服', '设置', '工作台', '发送', '确定', '取消', '更多']);

const EMPTY_STATE_PATTERNS = [
  '暂无会话中用户',
  '请选择会话',
  '与消费者聊天',
  '您今日暂无接待数据',
  '当前会话无用户',
  '暂无接待数据',
];

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isSingleLineUiNoise(text) {
  const s = normalizeText(text);
  if (!s || s.length < 2) return true;
  if (UI_NOISE_EXACT.has(s)) return true;
  for (const p of UI_NOISE_PARTIAL) {
    if (s === p || s.startsWith(p)) return true;
  }
  if (s.length <= 4 && /^(在线|三方|首页|接待|通知|售后)$/.test(s)) return true;
  if (/^《.+》$/.test(s)) return true;
  if (/^加载中/.test(s)) return true;
  return false;
}

function isUiNoise(text) {
  const raw = String(text || '');
  if (raw.includes('\n')) {
    const lines = raw.split(/\r?\n/).map((l) => normalizeText(l)).filter(Boolean);
    if (lines.length === 0) return true;
    const noiseOrEmpty = lines.filter((l) => isSingleLineUiNoise(l) || detectEmptyState(l).empty);
    if (noiseOrEmpty.length === lines.length) return true;
    if (lines.length >= 2 && noiseOrEmpty.length >= Math.ceil(lines.length * 0.7)) return true;
  }
  return isSingleLineUiNoise(raw);
}

function isValidShopName(name) {
  const s = normalizeText(name);
  if (!s || s.length < 2) return false;
  if (INVALID_SHOP_NAMES.has(s)) return false;
  if (isUiNoise(s)) return false;
  return true;
}

function detectEmptyState(text) {
  const s = normalizeText(text);
  for (const p of EMPTY_STATE_PATTERNS) {
    if (s.includes(p)) return { empty: true, stateText: p, reason: 'no_active_conversation' };
  }
  return { empty: false };
}

function classifyCaptureText(text) {
  const normalized = normalizeText(text);
  const empty = detectEmptyState(normalized);
  if (empty.empty) return { kind: 'empty_state', ...empty, text: normalized };
  if (isUiNoise(normalized)) return { kind: 'ui_noise', text: normalized };
  return { kind: 'candidate', text: normalized };
}

module.exports = {
  UI_NOISE_EXACT,
  UI_NOISE_PARTIAL,
  INVALID_SHOP_NAMES,
  EMPTY_STATE_PATTERNS,
  normalizeText,
  isSingleLineUiNoise,
  isUiNoise,
  isValidShopName,
  detectEmptyState,
  classifyCaptureText,
};
