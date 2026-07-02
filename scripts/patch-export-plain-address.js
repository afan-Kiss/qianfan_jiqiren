#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

const inPath =
  process.argv[2] ||
  path.join(os.homedir(), 'Desktop', '千帆订单_四店全量_20260301-20260702_1829条.json');

const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
for (const r of data.rows || []) {
  const la = String(r.list_buyer_address || r.addressMasked || '');
  if (la && !la.includes('@@') && !r.addressPlain) r.addressPlain = la;
}
const cols = Object.keys(data.rows[0] || {});
const esc = (v) => {
  const s = String(v ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};
const csvPath = inPath.replace(/\.json$/i, '.csv');
fs.writeFileSync(csvPath, `\uFEFF${[cols.join(','), ...(data.rows || []).map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')}`, 'utf8');
fs.writeFileSync(inPath, JSON.stringify(data, null, 2), 'utf8');
console.log('addressPlain', data.rows.filter((r) => r.addressPlain).length, '/', data.rows.length);
