/** 运行时探测到的千帆 DevTools 端口（与 config 不一致时自动采用） */
let detectedDevToolsPort = null;

function setDetectedDevToolsPort(port) {
  const value = Number(port);
  if (!Number.isFinite(value) || value <= 0) return;
  detectedDevToolsPort = value;
}

function getDetectedDevToolsPort() {
  return detectedDevToolsPort;
}

function resolveEffectiveDevToolsPort(configuredPort) {
  return detectedDevToolsPort || Number(configuredPort) || 9322;
}

function clearDetectedDevToolsPort() {
  detectedDevToolsPort = null;
}

module.exports = {
  setDetectedDevToolsPort,
  getDetectedDevToolsPort,
  resolveEffectiveDevToolsPort,
  clearDetectedDevToolsPort,
};
