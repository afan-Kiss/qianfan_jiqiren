const fs = require('fs');
const path = require('path');
const asar = require('asar');
const { println } = require('../../shared/logger');
const {
  SEARCH_KEYWORDS,
  PRIORITY_URLS,
  ENTRY_CANDIDATES,
  CONFIG_FILES,
  SENSITIVE_LOG_PATTERNS,
  PATCH_TARGET_FILE,
  WORKSPACE_URL_PATTERN,
} = require('./doudian-asar-keywords');

function normalizeListPath(listPath) {
  return String(listPath || '').replace(/^\\/, '');
}

function shouldScanFile(filePath) {
  if (!/\.(js|html|json|cjs|mjs|ts)$/i.test(filePath)) return false;
  if (filePath.includes('node_modules') && !/electron-runtime|\\electron\\/.test(filePath)) return false;
  return true;
}

function redactLine(line) {
  let out = String(line || '');
  for (const re of SENSITIVE_LOG_PATTERNS) {
    if (re.test(out)) return '[redacted-sensitive-line]';
  }
  return out.length > 240 ? `${out.slice(0, 240)}...[truncated]` : out;
}

function findKeywordHits(text, keywords = SEARCH_KEYWORDS) {
  const hits = [];
  for (const kw of keywords) {
    let idx = 0;
    let lineNo = 1;
    let pos = 0;
    const lines = text.split(/\r?\n/);
    while (true) {
      const i = text.indexOf(kw, idx);
      if (i < 0) break;
      while (pos + lines[lineNo - 1].length + 1 <= i && lineNo < lines.length) {
        pos += lines[lineNo - 1].length + 1;
        lineNo += 1;
      }
      hits.push({
        keyword: kw,
        index: i,
        line: lineNo,
        snippet: redactLine(lines[lineNo - 1] || text.slice(Math.max(0, i - 80), i + 120)),
      });
      idx = i + kw.length;
      if (hits.filter((h) => h.keyword === kw).length >= 5) break;
    }
  }
  return hits;
}

function resolveInstallPaths(installDir) {
  const root = path.resolve(installDir);
  const resourcesDir = path.join(root, 'resources');
  const asarPath = path.join(resourcesDir, 'app.asar');
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');
  return { root, resourcesDir, asarPath, unpackedDir };
}

function readDiskConfigFiles(root) {
  const found = [];
  for (const name of CONFIG_FILES) {
    const direct = path.join(root, name);
    const inResources = path.join(root, 'resources', name);
    for (const p of [direct, inResources]) {
      if (fs.existsSync(p)) {
        found.push({ name, path: p, size: fs.statSync(p).size });
      }
    }
  }
  return found;
}

function extractAsarFile(asarPath, listPath) {
  const inner = normalizeListPath(listPath);
  return asar.extractFile(asarPath, inner);
}

function listAsarFiles(asarPath) {
  return asar.listPackage(asarPath).map(normalizeListPath);
}

function scoreCandidate(filePath, hits) {
  let score = hits.length;
  if (filePath === PATCH_TARGET_FILE.replace(/\\/g, '\\')) score += 20;
  if (/webview_preload_index\.js$/i.test(filePath)) score += 18;
  if (/webview_preload_vendor\.js$/i.test(filePath)) score += 12;
  if (/im_container/i.test(filePath)) score += 10;
  if (/ops_container/i.test(filePath)) score += 8;
  if (/electron\\main\.js$/i.test(filePath)) score += 6;
  if (hits.some((h) => h.keyword === 'pc_seller_desk_v2' || h.keyword === 'main/workspace')) score += 8;
  if (hits.some((h) => h.keyword === 'executeJavaScript' || h.keyword === 'did-finish-load')) score += 5;
  return score;
}

function buildRecommendations(report) {
  const candidates = report.entryCandidates
    .filter((c) => c.exists)
    .sort((a, b) => b.score - a.score);

  const top = candidates[0] || null;
  const canUseCdp = Boolean(report.cdpHint?.canInject);

  return {
    canUseCdp,
    needAsarInject: !canUseCdp,
    patchEnabledRequired: !canUseCdp,
    recommendedInjectPoint: top
      ? {
          file: top.file,
          score: top.score,
          reason: top.file.includes('webview_preload')
            ? 'webview preload 在客服页加载时执行，可安全挂 bridge'
            : '容器页面入口，可配合 webview 事件注入',
        }
      : null,
    recommendedListenPage: WORKSPACE_URL_PATTERN,
    recommendedSendPage: WORKSPACE_URL_PATTERN,
    recommendedPatchTarget: PATCH_TARGET_FILE,
    topCandidates: candidates.slice(0, 8),
  };
}

function analyzeDoudianInstall(installDir, options = {}) {
  const paths = resolveInstallPaths(installDir);
  println(`分析安装目录：${paths.root}`);

  if (!fs.existsSync(paths.asarPath)) {
    return {
      ok: false,
      reason: 'app_asar_missing',
      paths,
      message: `未找到 ${paths.asarPath}`,
    };
  }

  println('发现 app.asar');

  const asarFiles = listAsarFiles(paths.asarPath);
  const configFiles = readDiskConfigFiles(paths.root);
  const keywordHitsByFile = {};
  let scanned = 0;

  const scanTargets = new Set();
  for (const c of ENTRY_CANDIDATES) scanTargets.add(c.replace(/\//g, '\\'));
  for (const f of asarFiles) {
    if (shouldScanFile(f)) scanTargets.add(f);
  }

  for (const file of scanTargets) {
    if (!asarFiles.includes(file)) continue;
    try {
      const text = extractAsarFile(paths.asarPath, file).toString('utf8');
      scanned += 1;
      const hits = findKeywordHits(text);
      if (hits.length) keywordHitsByFile[file] = { size: text.length, hits };
    } catch {
      // skip unreadable
    }
  }

  const entryCandidates = ENTRY_CANDIDATES.map((file) => {
    const exists = asarFiles.includes(file);
    const hitInfo = keywordHitsByFile[file];
    return {
      file,
      exists,
      size: hitInfo?.size || 0,
      hits: hitInfo?.hits || [],
      score: exists ? scoreCandidate(file, hitInfo?.hits || []) : 0,
    };
  });

  for (const file of Object.keys(keywordHitsByFile)) {
    if (entryCandidates.some((c) => c.file === file)) continue;
    const hitInfo = keywordHitsByFile[file];
    entryCandidates.push({
      file,
      exists: true,
      size: hitInfo.size,
      hits: hitInfo.hits,
      score: scoreCandidate(file, hitInfo.hits),
    });
  }

  const imContainer = entryCandidates.find((c) => c.file.includes('im_container'));
  const opsContainer = entryCandidates.find((c) => c.file.includes('ops_container'));
  if (imContainer?.exists) println('发现 im_container');
  if (opsContainer?.exists) println('发现 ops_container');

  const priorityUrlHits = [];
  for (const [file, info] of Object.entries(keywordHitsByFile)) {
    for (const url of PRIORITY_URLS) {
      if (info.hits.some((h) => h.snippet.includes(url) || h.keyword === url)) {
        priorityUrlHits.push({ file, url });
      }
    }
    const textSample = info.hits.map((h) => h.snippet).join(' ');
    if (textSample.includes(WORKSPACE_URL_PATTERN)) {
      priorityUrlHits.push({ file, url: WORKSPACE_URL_PATTERN });
      println(`发现客服页 URL: ${WORKSPACE_URL_PATTERN} (${file})`);
    }
  }

  const report = {
    ok: true,
    installDir: paths.root,
    paths,
    asarFileCount: asarFiles.length,
    scannedFileCount: scanned,
    configFiles,
    entryCandidates: entryCandidates.filter((c) => c.exists || c.hits.length),
    keywordHitsByFile,
    priorityUrlHits,
    cdpHint: options.cdpHint || null,
    analyzedAt: Date.now(),
  };

  report.recommendations = buildRecommendations(report);

  const top = report.recommendations.recommendedInjectPoint;
  if (top) println(`找到候选注入点：${top.file} (score=${top.score})`);
  else println('未找到明确注入点，请人工检查分析报告');

  if (!report.recommendations.canUseCdp) {
    println('patch 默认未启用，仅输出建议');
  }

  return report;
}

module.exports = {
  normalizeListPath,
  resolveInstallPaths,
  listAsarFiles,
  extractAsarFile,
  analyzeDoudianInstall,
  buildRecommendations,
  findKeywordHits,
};
