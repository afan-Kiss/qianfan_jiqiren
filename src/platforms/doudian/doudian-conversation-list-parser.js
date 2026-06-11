function maskIdForReport(value = '') {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 8) return `${s.slice(0, 2)}***`;
  return `${s.slice(0, 8)}***`;
}

function maskTextForReport(text = '', maxLen = 120) {
  return String(text || '')
    .slice(0, maxLen)
    .replace(/1\d{10}/g, (m) => `${m.slice(0, 3)}****${m.slice(-4)}`)
    .replace(/\b\d{12,22}\b/g, (m) => `${m.slice(0, 4)}***${m.slice(-4)}`);
}

function normalizeConversationEntry(entry = {}, index = 0) {
  return {
    index: Number(entry.index ?? index),
    buyerId: maskIdForReport(entry.buyerId || ''),
    buyerName: maskTextForReport(entry.buyerName || '', 60),
    conversationId: maskIdForReport(entry.conversationId || ''),
    lastMessage: maskTextForReport(entry.lastMessage || '', 120),
    timeText: maskTextForReport(entry.timeText || '', 40),
    selected: Boolean(entry.selected),
  };
}

function parseConversationListPayload(payload = {}) {
  const conversations = (Array.isArray(payload.conversations) ? payload.conversations : []).map(
    (c, i) => normalizeConversationEntry(c, i)
  );
  const selectedRaw = payload.selectedConversation || {};
  let selectedConversation = normalizeConversationEntry(
    { ...selectedRaw, selected: true },
    -1
  );
  selectedConversation.selected = true;

  const selectedFromList = conversations.find((c) => c.selected);
  if (selectedFromList) {
    selectedConversation = {
      ...selectedFromList,
      selected: true,
      buyerId: pickFirst(selectedConversation.buyerId, selectedFromList.buyerId),
      buyerName: pickFirst(selectedConversation.buyerName, selectedFromList.buyerName),
      conversationId: pickFirst(selectedConversation.conversationId, selectedFromList.conversationId),
      lastMessage: pickFirst(selectedConversation.lastMessage, selectedFromList.lastMessage),
    };
  }

  return {
    conversations,
    selectedConversation,
    count: conversations.length,
  };
}

function pickFirst(...values) {
  for (const v of values) {
    const s = String(v || '').trim();
    if (s) return s;
  }
  return '';
}

function formatConversationListTerminal(conversations = [], selectedConversation = {}) {
  const lines = ['[抖店桥] 当前会话列表：'];
  const list = conversations.length ? conversations : [selectedConversation];
  list.slice(0, 10).forEach((c, i) => {
    const n = Math.max(0, Number(c.index ?? i)) + 1;
    const name = c.buyerName || '(未知买家)';
    const time = c.timeText ? `  ${c.timeText}` : '';
    const msg = c.lastMessage ? `  ${c.lastMessage}` : '';
    const mark = c.selected ? '  [当前选中]' : '';
    lines.push(`${n}. ${name}${time}${msg}${mark}`);
  });
  if (!list.length) {
    lines.push('(未读取到会话列表，请确认 IM 左侧列表可见)');
  }
  return lines;
}

module.exports = {
  parseConversationListPayload,
  formatConversationListTerminal,
  maskIdForReport,
  maskTextForReport,
  normalizeConversationEntry,
};
