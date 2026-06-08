function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function crashAfterReady(delayMs = 200) {
  setTimeout(() => process.exit(1), delayMs);
}

module.exports = {
  sleep,
  crashAfterReady,
};
