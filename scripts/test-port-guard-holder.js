#!/usr/bin/env node
const http = require('http');
const port = Number(process.argv[2] || 19629);
const server = http.createServer((_req, res) => res.end('holder'));
server.listen(port, '127.0.0.1');
