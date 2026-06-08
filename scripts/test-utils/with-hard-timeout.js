function withHardTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label || 'test'} timed out after ${ms}ms`));
      }, ms);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

module.exports = {
  withHardTimeout,
};
