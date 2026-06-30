const assert = require('assert');
const fs = require('fs');
const path = require('path');

const collector = require('../src/qianfan-cookie-collector');
const apiSrc = fs.readFileSync(path.join(__dirname, '../src/qianfan-local-api.js'), 'utf8');

assert.strictEqual(typeof collector.runSyncNowAll, 'function');
assert.strictEqual(typeof collector.getAutoSyncStatus, 'function');
assert(apiSrc.includes('/api/cookie/sync-now'));
assert(apiSrc.includes('/api/health'));
assert(!apiSrc.includes('res.end(cookie)'));

console.log('[check-qianfan-cookie-sync-api] passed');
