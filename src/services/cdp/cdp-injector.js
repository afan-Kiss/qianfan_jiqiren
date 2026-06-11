const fs = require('fs');
const path = require('path');
const { bridgeLog } = require('../../shared/bridge-log');

function loadHookScript() {
  const file = path.join(__dirname, '../../inject/qianfan-ws-hook.js');
  return fs.readFileSync(file, 'utf8');
}

function buildBindingBootstrap(bindingName) {
  return `
    window.__QF_BRIDGE_EMIT__ = function(payload) {
      try {
        ${bindingName}(payload);
      } catch (e) {}
    };
  `;
}

async function injectHook(client, options = {}) {
  const target = options.target || {};
  const bindingName = options.bindingName || '__qfBridgeEmit';
  const source = loadHookScript() + buildBindingBootstrap(bindingName);

  try {
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Runtime.addBinding', { name: bindingName });

    if (options.injectOnNewDocument !== false) {
      await client.send('Page.addScriptToEvaluateOnNewDocument', { source });
      bridgeLog('[CDP_INJECT]', `addScriptToEvaluateOnNewDocument ok target=${target.targetId || ''}`);
    }

    const check = await client.send('Runtime.evaluate', {
      expression: 'Boolean(window.__QF_CDP_BRIDGE_INSTALLED__)',
      returnByValue: true,
    });

    if (!check?.result?.value) {
      await client.send('Runtime.evaluate', { expression: source, awaitPromise: false });
      bridgeLog('[CDP_INJECT]', `Runtime.evaluate 补注入 target=${target.targetId || ''}`);
    }

    const verified = await client.send('Runtime.evaluate', {
      expression: 'Boolean(window.__QF_CDP_BRIDGE_INSTALLED__)',
      returnByValue: true,
    });

    const installed = Boolean(verified?.result?.value);
    bridgeLog('[CDP_INJECT]', `注入${installed ? '成功' : '失败'} title=${(target.title || '').slice(0, 40)} targetId=${target.targetId || ''}`);
    return { ok: installed, reason: installed ? 'inject_ok' : 'inject_failed' };
  } catch (err) {
    bridgeLog('[BRIDGE_ERROR]', '[CDP_INJECT] 注入异常', String(err.message || err));
    return { ok: false, reason: 'inject_error', error: String(err.message || err) };
  }
}

module.exports = {
  loadHookScript,
  injectHook,
};
