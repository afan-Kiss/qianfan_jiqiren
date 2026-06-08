function buildQianfanCmdHint(config = {}) {
  const port = Number(config.devtoolsPort || 9223);
  const host = config.devtoolsHost || '127.0.0.1';
  const exePath = String(config.qianfanClientExePath || 'E:\\千帆\\eva\\千帆客服工作台.exe').trim();
  const workDir = String(config.qianfanClientWorkingDir || 'E:\\千帆\\eva').trim();
  return [
    '请先用 cmd 以调试模式启动千帆客服工作台，再点「启动中转」。',
    `可双击运行：启动千帆调试模式.bat`,
    `或手动执行：cd /d "${workDir}" && start "" "${exePath}" --remote-debugging-port=${port} --remote-debugging-address=${host} --remote-allow-origins=* --disable-features=BlockInsecurePrivateNetworkRequests`,
  ].join('\n');
}

module.exports = {
  buildQianfanCmdHint,
};
