function getDelayMs() {
  return Number(process.env.QIANFAN_SIM_PERSIST_DELAY_MS || 0);
}

async function maybeDelay() {
  const delayMs = getDelayMs();
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

module.exports = {
  getDelayMs,
  maybeDelay,
};
