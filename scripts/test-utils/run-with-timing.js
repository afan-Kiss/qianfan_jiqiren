const { spawn } = require('child_process');
const path = require('path');

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function resolveNodeScript(scriptName, packageScripts, rootDir) {
  const command = packageScripts[scriptName];
  if (!command) {
    throw new Error(`unknown npm script: ${scriptName}`);
  }
  const match = command.match(/^node\s+(\S+)(?:\s+(.*))?$/);
  if (!match) {
    throw new Error(`script ${scriptName} is not a direct node command: ${command}`);
  }
  return {
    scriptPath: path.resolve(rootDir, match[1]),
    args: match[2] ? match[2].split(/\s+/) : [],
  };
}

function runNodeScript(scriptName, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const packageScripts = options.packageScripts || {};
  const { scriptPath, args } = resolveNodeScript(scriptName, packageScripts, rootDir);
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: rootDir,
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      const elapsedMs = Date.now() - started;
      if (code === 0) {
        resolve({ scriptName, elapsedMs, ok: true });
        return;
      }
      reject(Object.assign(new Error(`${scriptName} failed with exit code ${code}`), {
        scriptName,
        elapsedMs,
        exitCode: code,
      }));
    });
  });
}

async function runScriptsWithTiming(scriptNames, options = {}) {
  const warnMs = options.warnMs ?? 30000;
  const results = [];
  const totalStarted = Date.now();

  for (const scriptName of scriptNames) {
    const result = await runNodeScript(scriptName, options);
    results.push(result);
    if (result.elapsedMs > warnMs) {
      console.warn(`[timing] WARNING: ${scriptName} took ${formatSeconds(result.elapsedMs)} (> ${formatSeconds(warnMs)})`);
    }
  }

  console.log('\ncheck timing:');
  for (const item of results) {
    console.log(`- ${item.scriptName} ${formatSeconds(item.elapsedMs)}`);
  }
  console.log(`\ntotal: ${formatSeconds(Date.now() - totalStarted)}`);

  return results;
}

module.exports = {
  formatSeconds,
  resolveNodeScript,
  runNodeScript,
  runScriptsWithTiming,
};
