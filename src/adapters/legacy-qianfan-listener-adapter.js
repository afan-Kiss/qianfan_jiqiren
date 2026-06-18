const config = require('../wechat/wxbot-new-config');
const { createQianfanRuntimeController } = require('./qianfan-runtime-controller');
const {
  startQianfanMessageListener,
  releaseSeenBuyerMessage,
} = require('../qianfan-message-listener');
const { ok, fail } = require('./adapter-result');

function isSimMode() {
  return process.env.QIANFAN_SIM_MODE === '1';
}

let listenerHandle = null;

async function prepareQianfanRuntime(runtimeController) {
  try {
    const controller = runtimeController || createQianfanRuntimeController({
      config: { ...config.qianfanDebug, root: config.root },
    });
    const readyResult = await controller.ensureQianfanReady();
    return ok({
      readyResult,
      attachResult: readyResult.attachResult,
      qianfanCfg: controller.getConfig(),
      qianfanRuntime: controller.getStatus(),
    });
  } catch (err) {
    return fail(err, 'QIANFAN_PREP_FAILED');
  }
}

async function startBuyerListener({
  onBuyerMessage,
  runtimeController,
  attachResult: providedAttachResult,
} = {}) {
  try {
    if (isSimMode()) {
      const { startFakeBuyerListener } = require('../../scripts/sim/fake-qianfan-events');
      const started = startFakeBuyerListener({ onBuyerMessage });
      listenerHandle = started.data?.listenerHandle || { stop: async () => ok({ stopped: true }) };
      return ok({ listenerHandle, attachResult: { canStartListener: true, sim: true } });
    }

    const controller = runtimeController || createQianfanRuntimeController({
      config: { ...config.qianfanDebug, root: config.root },
    });

    let attachResult = providedAttachResult;
    let qianfanCfg = controller.getConfig();

    if (!attachResult) {
      const prep = await prepareQianfanRuntime(controller);
      if (!prep.ok) return prep;
      attachResult = prep.data.attachResult;
      qianfanCfg = prep.data.qianfanCfg;
    }

    if (!attachResult?.canStartListener) {
      const reason = attachResult?.devtoolsAccessible
        ? '千帆已启动，店铺工作台页面还在加载，请稍候'
        : '千帆未接入，无法启动监听';
      return fail(new Error(reason), 'QIANFAN_NOT_ATTACHED', {
        qianfanRuntime: controller.getStatus(),
      });
    }

    listenerHandle = await startQianfanMessageListener({
      devtoolsPort: qianfanCfg.devtoolsPort,
      devtoolsHost: qianfanCfg.devtoolsHost,
      expectedShopCount: qianfanCfg.expectedShopCount,
      shopReport: attachResult.shopReport,
      pages: attachResult.shopReport?.shops,
      onBuyerMessage: (message, options) => {
        if (typeof onBuyerMessage === 'function') {
          onBuyerMessage(message, options);
        }
      },
    });

    return ok({ listenerHandle, attachResult, qianfanRuntime: controller.getStatus() });
  } catch (err) {
    return fail(err, 'QIANFAN_LISTENER_FAILED');
  }
}

async function stopBuyerListener() {
  try {
    if (listenerHandle && typeof listenerHandle.stop === 'function') {
      await listenerHandle.stop();
    }
    listenerHandle = null;
    return ok({ stopped: true });
  } catch (err) {
    return fail(err, 'QIANFAN_LISTENER_STOP_FAILED');
  }
}

function isBuyerListenerActive() {
  return listenerHandle != null;
}

module.exports = {
  prepareQianfanRuntime,
  startBuyerListener,
  stopBuyerListener,
  releaseSeenBuyerMessage,
  isBuyerListenerActive,
};
