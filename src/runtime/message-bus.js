const { EventEmitter } = require('events');
const crypto = require('crypto');
const { getTopicTargets, getTopicAliases } = require('./worker-registry');

class MessageBus extends EventEmitter {
  constructor() {
    super();
    this.publishedMessages = [];
  }

  newTraceId() {
    return crypto.randomBytes(8).toString('hex');
  }

  normalizeMeta(meta = {}, from = 'supervisor') {
    return {
      traceId: meta.traceId || this.newTraceId(),
      requestId: meta.requestId || '',
      replyTo: meta.replyTo || '',
      from: meta.from || from,
      time: meta.time || Date.now(),
    };
  }

  buildMessage(topic, payload, meta = {}, from = 'supervisor') {
    return {
      topic,
      payload,
      meta: this.normalizeMeta(meta, from),
    };
  }

  publish(topic, payload, meta = {}, from = 'supervisor') {
    const message = this.buildMessage(topic, payload, meta, from);
    this.publishedMessages.push(message);
    this.emit('published', message);

    for (const aliasTopic of getTopicAliases(topic)) {
      const aliasMessage = this.buildMessage(aliasTopic, payload, message.meta, from);
      this.publishedMessages.push(aliasMessage);
      this.emit('published', aliasMessage);
    }

    return message;
  }

  routeFromWorker(workerName, message = {}) {
    if (message.type === 'worker.subscribe') {
      return {
        type: 'worker.subscribed',
        workerName,
        topics: message.topics || [],
      };
    }

    if (message.type !== 'bus.publish') return null;

    const busMessage = this.publish(
      message.topic,
      message.payload,
      { ...message.meta, from: workerName },
      workerName,
    );

    const targets = getTopicTargets(message.topic);
    const aliasTargets = getTopicAliases(message.topic).flatMap((alias) => getTopicTargets(alias));

    return {
      type: 'bus.published',
      topic: busMessage.topic,
      meta: busMessage.meta,
      targets: [...new Set([...targets, ...aliasTargets])],
    };
  }

  getTargetsForTopic(topic) {
    const direct = getTopicTargets(topic);
    const alias = getTopicAliases(topic).flatMap((aliasTopic) => getTopicTargets(aliasTopic));
    return [...new Set([...direct, ...alias])];
  }
}

module.exports = {
  MessageBus,
};
