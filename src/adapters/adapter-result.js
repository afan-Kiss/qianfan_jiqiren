function ok(data) {
  return { ok: true, data };
}

function fail(error, code = 'ADAPTER_ERROR') {
  const err = error instanceof Error ? error : new Error(String(error || 'unknown error'));
  return {
    ok: false,
    error: {
      message: err.message,
      stack: err.stack || '',
      code,
    },
  };
}

module.exports = {
  ok,
  fail,
};
