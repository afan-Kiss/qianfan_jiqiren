const fs = require('fs');
const path = require('path');

const EXE_NAME = '千帆客服工作台.exe';

function buildCandidatePaths() {
  const candidates = [
    'E:\\千帆\\eva',
    'E:\\文档\\千帆\\eva',
    'D:\\千帆\\eva',
    'C:\\千帆\\eva',
  ];
  for (const letter of ['C', 'D', 'E', 'F']) {
    candidates.push(`${letter}:\\千帆\\eva`);
    candidates.push(`${letter}:\\文档\\千帆\\eva`);
  }
  return [...new Set(candidates)];
}

function detectQianfanInstall() {
  for (const dir of buildCandidatePaths()) {
    const exePath = path.join(dir, EXE_NAME);
    if (fs.existsSync(exePath)) {
      return { exePath, workingDir: dir };
    }
  }
  return null;
}

function resolveQianfanClientPaths(fileCfg = {}) {
  const qianfanDebug = fileCfg.qianfanDebug || {};
  const configuredExe = String(qianfanDebug.qianfanClientExePath || '').trim();
  const configuredDir = String(qianfanDebug.qianfanClientWorkingDir || '').trim();

  if (configuredExe && fs.existsSync(configuredExe)) {
    return {
      qianfanClientExePath: configuredExe,
      qianfanClientWorkingDir: configuredDir || path.dirname(configuredExe),
    };
  }

  const detected = detectQianfanInstall();
  if (detected) {
    return {
      qianfanClientExePath: detected.exePath,
      qianfanClientWorkingDir: detected.workingDir,
    };
  }

  return {
    qianfanClientExePath: configuredExe || 'E:\\千帆\\eva\\千帆客服工作台.exe',
    qianfanClientWorkingDir: configuredDir || 'E:\\千帆\\eva',
  };
}

module.exports = {
  detectQianfanInstall,
  resolveQianfanClientPaths,
  EXE_NAME,
};
