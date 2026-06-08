const fs = require('fs');
const path = require('path');
const { TOPIC_ROUTES } = require('../src/runtime/worker-registry');

const ROOT = path.resolve(__dirname, '..');
const errors = [];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function assert(cond, message) {
  if (!cond) errors.push(message);
}

function main() {
  const listener = read('src/workers/qianfan-listener.worker.js');
  const sender = read('src/workers/qianfan-sender.worker.js');

  assert(
    TOPIC_ROUTES['qianfan.send.execute']?.includes('qianfan-listener'),
    'qianfan.send.execute must route to qianfan-listener (CDP bridge owner)',
  );
  assert(listener.includes('qianfan.send.execute'), 'qianfan-listener must subscribe qianfan.send.execute');
  assert(listener.includes('sendQianfanReplyRequest'), 'qianfan-listener must call sendQianfanReplyRequest');
  assert(!sender.includes('sendQianfanReplyRequest'), 'qianfan-sender must not call sendQianfanReplyRequest');
  assert(sender.includes('qianfan.send.execute'), 'qianfan-sender must publish qianfan.send.execute after dedup');

  if (errors.length) {
    console.error('[check-qianfan-send-bridge-worker] FAILED');
    for (const err of errors) console.error(`- ${err}`);
    process.exit(1);
  }

  console.log('[check-qianfan-send-bridge-worker] OK');
}

main();
