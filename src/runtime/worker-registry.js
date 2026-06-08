const path = require('path');

const WORKER_NAMES = {
  PERSISTENCE: 'persistence',
  WECHAT_CALLBACK: 'wechat-callback',
  WECHAT_NOTIFIER: 'wechat-notifier',
  WECHAT_REPLY: 'wechat-reply',
  QIANFAN_LISTENER: 'qianfan-listener',
  QIANFAN_SENDER: 'qianfan-sender',
};

/** topic -> 目标 worker 列表（supervisor 跨进程转发依据） */
const TOPIC_ROUTES = {
  'buyer-message.detected': ['wechat-notifier'],
  'wechat.notify.request': ['wechat-notifier'],
  'wechat.reply.received': ['wechat-reply'],
  'qianfan.send.request': ['qianfan-sender'],
  'qianfan.send.execute': ['qianfan-listener'],
  'task.persist.request': ['persistence'],
  'qianfan.send.result': ['wechat-reply', 'persistence'],
  'wechat.notify.result': ['persistence'],
};

/** 发布后额外转发的 topic 别名（保留 traceId） */
const TOPIC_ALIASES = {};

/** 各 worker 本地订阅的 topic（用于边界检查与文档） */
const WORKER_TOPIC_SUBSCRIPTIONS = {
  [WORKER_NAMES.PERSISTENCE]: ['task.persist.request', 'qianfan.send.result', 'wechat.notify.result'],
  [WORKER_NAMES.WECHAT_CALLBACK]: [],
  [WORKER_NAMES.WECHAT_NOTIFIER]: ['buyer-message.detected'],
  [WORKER_NAMES.WECHAT_REPLY]: ['wechat.reply.received', 'qianfan.send.result'],
  [WORKER_NAMES.QIANFAN_LISTENER]: ['qianfan.send.execute'],
  [WORKER_NAMES.QIANFAN_SENDER]: ['qianfan.send.request'],
};

const START_ORDER = [
  WORKER_NAMES.PERSISTENCE,
  WORKER_NAMES.QIANFAN_SENDER,
  WORKER_NAMES.QIANFAN_LISTENER,
  WORKER_NAMES.WECHAT_CALLBACK,
  WORKER_NAMES.WECHAT_NOTIFIER,
  WORKER_NAMES.WECHAT_REPLY,
];

const QIANFAN_BOOT_ORDER = [
  WORKER_NAMES.PERSISTENCE,
  WORKER_NAMES.QIANFAN_SENDER,
  WORKER_NAMES.QIANFAN_LISTENER,
];

const WECHAT_BOOT_ORDER = [
  WORKER_NAMES.WECHAT_CALLBACK,
  WORKER_NAMES.WECHAT_NOTIFIER,
  WORKER_NAMES.WECHAT_REPLY,
];

const STOP_ORDER = [...START_ORDER].reverse();

function getWorkerEntries(runtimeRoot) {
  const workersDir = path.join(runtimeRoot, 'src', 'workers');
  const entry = (name) => path.join(workersDir, name);
  return {
    [WORKER_NAMES.PERSISTENCE]: entry('persistence.worker.js'),
    [WORKER_NAMES.WECHAT_CALLBACK]: entry('wechat-callback.worker.js'),
    [WORKER_NAMES.WECHAT_NOTIFIER]: entry('wechat-notifier.worker.js'),
    [WORKER_NAMES.WECHAT_REPLY]: entry('wechat-reply.worker.js'),
    [WORKER_NAMES.QIANFAN_LISTENER]: entry('qianfan-listener.worker.js'),
    [WORKER_NAMES.QIANFAN_SENDER]: entry('qianfan-sender.worker.js'),
  };
}

function getTopicTargets(topic) {
  return TOPIC_ROUTES[topic] ? [...TOPIC_ROUTES[topic]] : [];
}

function getTopicAliases(topic) {
  return TOPIC_ALIASES[topic] ? [...TOPIC_ALIASES[topic]] : [];
}

module.exports = {
  WORKER_NAMES,
  TOPIC_ROUTES,
  TOPIC_ALIASES,
  WORKER_TOPIC_SUBSCRIPTIONS,
  START_ORDER,
  QIANFAN_BOOT_ORDER,
  WECHAT_BOOT_ORDER,
  STOP_ORDER,
  getWorkerEntries,
  getTopicTargets,
  getTopicAliases,
};
