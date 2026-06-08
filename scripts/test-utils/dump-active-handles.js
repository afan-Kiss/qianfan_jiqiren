function dumpActiveHandles(label = 'active handles') {
  const handles = typeof process._getActiveHandles === 'function'
    ? process._getActiveHandles()
    : [];
  console.error(`[${label}] count=${handles.length}`);
  handles.forEach((handle, index) => {
    const name = handle && handle.constructor && handle.constructor.name
      ? handle.constructor.name
      : typeof handle;
    console.error(`  #${index}: ${name}`);
  });
  return handles.length;
}

module.exports = {
  dumpActiveHandles,
};
