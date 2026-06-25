let listenerHandle = null;

function isListenerRunning() {
  return listenerHandle != null;
}

function setListenerHandle(handle) {
  listenerHandle = handle || null;
}

function clearListenerHandle() {
  listenerHandle = null;
}

function getListenerHandle() {
  return listenerHandle;
}

module.exports = {
  isListenerRunning,
  setListenerHandle,
  clearListenerHandle,
  getListenerHandle,
};
