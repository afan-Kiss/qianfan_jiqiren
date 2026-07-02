/**
 * 解析「主播分析软件」路径（换票签名 Python + 品退探针脚本）
 * 便携版 exe 会从 Temp 解压运行，不能仅用 config.root 的 ../主播分析软件。
 */
const fs = require('fs');
const path = require('path');
const { resolveProjectRoot } = require('./shared/app-root');

function normalizeDir(input) {
  const raw = String(input || '').trim();
  return raw ? path.resolve(raw) : '';
}

function isServerRoot(dir) {
  const base = normalizeDir(dir);
  if (!base) return false;
  const py = path.join(base, 'tools', 'xhs_signer', '.venv', 'Scripts', 'python.exe');
  const script = path.join(base, 'tools', 'xhs_signer', 'signer.py');
  return fs.existsSync(py) && fs.existsSync(script);
}

function toServerRoot(analystRoot) {
  const base = normalizeDir(analystRoot);
  if (!base) return '';
  if (isServerRoot(base)) return base;
  const nested = path.join(base, 'apps', 'server');
  return isServerRoot(nested) ? nested : '';
}

function resolveAnalystAppRoot(options = {}) {
  const searched = [];
  const candidates = [];

  const configured = normalizeDir(
    process.env.ANALYST_APP_ROOT || options.analystAppRoot || ''
  );
  if (configured) {
    candidates.push(configured);
    if (configured.replace(/\\/g, '/').endsWith('/apps/server')) {
      candidates.push(path.dirname(path.dirname(configured)));
    }
  }

  const projectRoot = resolveProjectRoot();
  candidates.push(
    path.resolve(projectRoot, '..', '..', '主播分析软件'),
    path.resolve(projectRoot, '..', '主播分析软件'),
    path.resolve(__dirname, '..', '..', '主播分析软件')
  );

  for (const root of candidates) {
    if (!root) continue;
    searched.push(root);
    const serverRoot = toServerRoot(root);
    if (serverRoot) {
      const analystAppRoot = root.replace(/\\/g, '/').endsWith('/apps/server')
        ? path.dirname(path.dirname(root))
        : root;
      return { analystAppRoot, serverRoot, searched };
    }
  }

  return { analystAppRoot: null, serverRoot: null, searched };
}

function resolveXhsSignerPaths(options = {}) {
  const { analystAppRoot, serverRoot, searched } = resolveAnalystAppRoot(options);
  if (!serverRoot) {
    const hint =
      '请在 config.wxbot-new.json 的 shopCookieUpload.analystAppRoot 填写主播分析软件目录，' +
      '或设置环境变量 ANALYST_APP_ROOT';
    throw new Error(`${hint}。已尝试: ${searched.join(' | ')}`);
  }

  const python =
    normalizeDir(process.env.XHS_SIGN_PYTHON) ||
    path.join(serverRoot, 'tools', 'xhs_signer', '.venv', 'Scripts', 'python.exe');
  const signerScript = path.join(serverRoot, 'tools', 'xhs_signer', 'signer.py');
  const qualityProbeScript = path.join(
    serverRoot,
    'scripts',
    'dev',
    'test-external-cookie-quality-api.ts'
  );

  if (!fs.existsSync(python)) {
    throw new Error(`签名 Python 不存在: ${python}`);
  }
  if (!fs.existsSync(signerScript)) {
    throw new Error(`签名脚本不存在: ${signerScript}`);
  }

  return {
    analystAppRoot,
    serverRoot,
    python,
    signerScript,
    qualityProbeScript,
  };
}

module.exports = {
  resolveAnalystAppRoot,
  resolveXhsSignerPaths,
};
