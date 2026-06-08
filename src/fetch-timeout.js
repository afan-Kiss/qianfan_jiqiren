/**
 * fetch 统一超时
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  return fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(timeoutMs),
  });
}

module.exports = {
  fetchWithTimeout,
};
