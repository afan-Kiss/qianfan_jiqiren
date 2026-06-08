function println(...args) {
  console.log(...args);
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

module.exports = {
  println,
  nowIso,
  safeJsonParse,
};
