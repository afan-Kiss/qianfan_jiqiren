const path = require('path');

function isSimMode() {
  return process.env.QIANFAN_SIM_MODE === '1';
}

function installFakeDeps() {
  if (!isSimMode() || global.__QIANFAN_SIM_FAKE_INSTALLED__) return;
  global.__QIANFAN_SIM_FAKE_INSTALLED__ = true;

  const rootDir = process.cwd();
  const fakeWechat = require(path.join(rootDir, 'scripts/sim/fake-wechat-sender'));
  const fakeQianfan = require(path.join(rootDir, 'scripts/sim/fake-qianfan-sender'));

  fakeWechat.install();
  fakeQianfan.install();
}

module.exports = {
  isSimMode,
  installFakeDeps,
};
