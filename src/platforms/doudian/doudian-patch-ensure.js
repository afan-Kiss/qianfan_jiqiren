const { applyAsarPatch } = require('./doudian-asar-patcher');
const { verifyAsarPatch } = require('./doudian-asar-patch-verify');
const { getDoudianConfig } = require('../../shared/config');
const { writePatchManifest, createTimestampedAsarBackup } = require('./doudian-patch-manifest');
const { resolveInstallPaths } = require('./doudian-asar-analyzer');

async function ensureTestDirPatched(installDir, options = {}) {
  const cfg = getDoudianConfig();
  const bridgePort = Number(options.bridgePort || cfg.bridgePort || 19527);
  const force = Boolean(options.force);
  const cwd = options.cwd || process.cwd();

  const verifyBefore = verifyAsarPatch(installDir, { bridgePort });
  if (verifyBefore.ok && !force) {
    const manifest = writePatchManifest({
      installDir,
      verifyResult: verifyBefore,
      patchResult: { verify: verifyBefore, meta: { bridgePort, wsUrl: verifyBefore.expectedWsUrl } },
      cwd,
    });
    return {
      ok: true,
      already: true,
      verify: verifyBefore,
      manifest: manifest.manifest,
      manifestPath: manifest.manifestPath,
    };
  }

  const paths = resolveInstallPaths(installDir);
  const timestampedBackup = createTimestampedAsarBackup(paths.asarPath, cwd);

  const patch = await applyAsarPatch(installDir, {
    force: force || !verifyBefore.ok,
    bridgePort,
    forceOriginal: options.forceOriginal,
  });

  if (!patch.ok) {
    return {
      ok: false,
      reason: patch.reason || 'patch_failed',
      message: patch.message || '',
      verify: patch.verify || verifyBefore,
      timestampedBackupPath: timestampedBackup.ok ? timestampedBackup.backupPath : '',
    };
  }

  const verifyAfter = patch.verify || verifyAsarPatch(installDir, { bridgePort });
  const manifest = writePatchManifest({
    installDir,
    patchResult: patch,
    verifyResult: verifyAfter,
    backupPath: timestampedBackup.ok ? timestampedBackup.backupPath : '',
    cwd,
  });

  return {
    ok: true,
    already: Boolean(patch.already),
    patch,
    verify: verifyAfter,
    manifest: manifest.manifest,
    manifestPath: manifest.manifestPath,
    timestampedBackupPath: timestampedBackup.ok ? timestampedBackup.backupPath : '',
  };
}

module.exports = {
  ensureTestDirPatched,
};
