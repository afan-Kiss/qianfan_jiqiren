const { resolveApiName } = require('./doudian-pigeon-parser');

const SENSITIVE_RE =
  /cookie|token|csrf|authorization|x-ms-token|bd-ticket|session-sign|bearer\s|ticket/i;

const SENSITIVE_FIELD_RE =
  /(cookie|token|csrf|authorization|x-ms-token|bd-ticket|session-sign|bearer|ticket|password|secret)["']?\s*[:=]\s*["'][^"']*["']/gi;

function redactSensitiveFields(line) {
  let s = String(line || '');
  s = s.replace(SENSITIVE_FIELD_RE, '$1:"***"');
  s = s.replace(/1\d{10}/g, (m) => `${m.slice(0, 3)}****${m.slice(-4)}`);
  return s.slice(0, 2000);
}

function redactStdoutLine(line) {
  const raw = String(line || '');
  if (/init window with accounts/i.test(raw)) {
    return redactSensitiveFields(raw);
  }
  if (SENSITIVE_RE.test(raw)) return '';
  return redactSensitiveFields(raw).slice(0, 500);
}

function extractShopNameNear(line, shopIdIndex) {
  const slice = line.slice(Math.max(0, shopIdIndex - 80), shopIdIndex + 320);
  const nameMatch =
    slice.match(/(?:shopName|nickName|accountName|name)["']?\s*[:=]\s*["']([^"']{1,80})/i) ||
    slice.match(/(?:shopName|nickName|accountName|name)["']?\s*[:=]\s*([^"'\s,}]{2,80})/i);
  return nameMatch ? String(nameMatch[1]).trim() : '';
}

function extractPartitionNear(line, shopIdIndex) {
  const slice = line.slice(Math.max(0, shopIdIndex - 80), shopIdIndex + 320);
  const partitionMatch = slice.match(/sessionPartitionKey["']?\s*[:=]\s*["']([^"']+)/i);
  return partitionMatch ? String(partitionMatch[1]).trim() : '';
}

function extractAccountIdNear(line, index) {
  const slice = line.slice(Math.max(0, index - 120), index + 120);
  const idMatch =
    slice.match(/"id"\s*:\s*"(\d{10,20})"/i) ||
    slice.match(/\bid["']?\s*[:=]\s*["']?(\d{10,20})/i);
  return idMatch ? String(idMatch[1]).trim() : '';
}

function parseStdoutAccountsFromLine(rawLine) {
  if (!/init window with accounts/i.test(rawLine)) return [];
  const line = redactSensitiveFields(rawLine);
  const accounts = [];
  const seen = new Set();
  const persistRegex = /persist:(\d{10,20})/g;
  let match;
  while ((match = persistRegex.exec(line)) !== null) {
    const accountId = match[1];
    const sessionPartitionKey = `persist:${accountId}`;
    if (seen.has(sessionPartitionKey)) continue;
    seen.add(sessionPartitionKey);
    const slice = line.slice(Math.max(0, match.index - 320), match.index + 420);
    const shopIdMatch = slice.match(/shopId["']?\s*[:=]\s*["']?(\d{6,12})/i);
    const shopNameMatch = slice.match(/shopName["']?\s*[:=]\s*["']([^"']{1,80})/i);
    const accountIdFromMeta = extractAccountIdNear(line, match.index);
    accounts.push({
      accountId: accountIdFromMeta || accountId,
      sessionPartitionKey,
      shopId: shopIdMatch ? shopIdMatch[1] : '',
      shopName: shopNameMatch ? shopNameMatch[1].trim() : '',
      source: 'stdout_accounts',
    });
  }
  return accounts;
}

function parseAccountsLine(rawLine, byId, counters = {}, accountsOut = []) {
  if (!/init window with accounts/i.test(rawLine)) return;
  const line = redactSensitiveFields(rawLine);
  const parsedAccounts = parseStdoutAccountsFromLine(rawLine);
  for (const account of parsedAccounts) {
    accountsOut.push(account);
    if (account.shopId) {
      const entry = {
        shopId: account.shopId,
        shopName: account.shopName,
        sessionPartitionKey: account.sessionPartitionKey,
        accountId: account.accountId,
        source: 'stdout_accounts',
      };
      if (!byId.has(account.shopId)) byId.set(account.shopId, entry);
      else {
        const existing = byId.get(account.shopId);
        if (!existing.shopName && entry.shopName) existing.shopName = entry.shopName;
        if (!existing.sessionPartitionKey && entry.sessionPartitionKey) {
          existing.sessionPartitionKey = entry.sessionPartitionKey;
        }
        if (!existing.accountId && entry.accountId) existing.accountId = entry.accountId;
      }
    }
  }

  const accountHit = line.match(/(?:accountNum|shopAccountNum)["']?\s*[:=]\s*(\d+)/i);
  if (accountHit) {
    const n = Number(accountHit[1]);
    counters.accountNum = Math.max(counters.accountNum || 0, n);
    counters.shopAccountNum = Math.max(counters.shopAccountNum || 0, n);
  }

  const shopIdRegex = /shopId["']?\s*[:=]\s*["']?(\d{6,12})/gi;
  let match;
  while ((match = shopIdRegex.exec(line)) !== null) {
    const shopId = match[1];
    const shopName = extractShopNameNear(line, match.index);
    const sessionPartitionKey = extractPartitionNear(line, match.index);
    const accountId = extractAccountIdNear(line, match.index);
    const entry = {
      shopId,
      shopName,
      sessionPartitionKey,
      accountId,
      source: 'stdout_accounts',
    };
    if (!byId.has(shopId)) {
      byId.set(shopId, entry);
      continue;
    }
    const existing = byId.get(shopId);
    if (!existing.shopName && entry.shopName) existing.shopName = entry.shopName;
    if (!existing.sessionPartitionKey && entry.sessionPartitionKey) {
      existing.sessionPartitionKey = entry.sessionPartitionKey;
    }
    if (!existing.accountId && entry.accountId) existing.accountId = entry.accountId;
  }
}

function extractLoggedInShopsFromStdout(lines = []) {
  const byId = new Map();
  const counters = {};
  const stdoutAccounts = [];
  for (const raw of lines) {
    parseAccountsLine(raw, byId, counters, stdoutAccounts);
  }
  return { loggedInShops: [...byId.values()], stdoutAccounts };
}

function parseStdoutBusinessSignals(lines = []) {
  const shopIds = new Set();
  const accountIdsMasked = new Set();
  const apiSignals = new Set();
  const pigeonApiSignals = [];
  let accountNum = 0;
  let shopAccountNum = 0;

  const loggedInById = new Map();
  const accountCounters = {};
  const stdoutAccounts = [];
  for (const raw of lines) {
    parseAccountsLine(raw, loggedInById, accountCounters, stdoutAccounts);
  }
  accountNum = accountCounters.accountNum || 0;
  shopAccountNum = accountCounters.shopAccountNum || 0;
  const loggedInShops = [...loggedInById.values()];
  for (const shop of loggedInShops) {
    if (shop.shopId) shopIds.add(shop.shopId);
  }

  for (const raw of lines) {
    const line = redactStdoutLine(raw);
    if (!line) continue;

    if (/write memory cache/i.test(line)) {
      const urlMatch = line.match(/https?:\/\/[^\s"']+/i);
      const url = urlMatch ? urlMatch[0] : '';
      const apiName = resolveApiName(url);
      apiSignals.add(apiName);
      pigeonApiSignals.push({ apiName, url: sanitizeUrlForReport(url), source: 'stdout_memory_cache' });
      const persistHit = line.match(/persist:(\d{10,20})/);
      if (persistHit) {
        accountIdsMasked.add(`persist:${persistHit[1].slice(0, 3)}***${persistHit[1].slice(-2)}`);
      }
    }

    const shopIdHits = line.match(/shopId["']?\s*[:=]\s*["']?(\d{6,12})/gi) || [];
    for (const hit of shopIdHits) {
      const id = hit.replace(/[^\d]/g, '');
      if (id) shopIds.add(id);
    }

    const accountHit = line.match(/accountNum["']?\s*[:=]\s*(\d+)/i);
    if (accountHit) accountNum = Math.max(accountNum, Number(accountHit[1]));
    const shopAccountHit = line.match(/shopAccountNum["']?\s*[:=]\s*(\d+)/i);
    if (shopAccountHit) shopAccountNum = Math.max(shopAccountNum, Number(shopAccountHit[1]));

    const sessionHit = line.match(/sessionPartitionKey["']?\s*[:=]\s*["']?([^"'\s,}]+)/i);
    if (sessionHit) {
      const v = sessionHit[1];
      accountIdsMasked.add(v.length > 6 ? `${v.slice(0, 3)}***${v.slice(-2)}` : '***');
    }
  }

  const loggedInShopCount = Math.max(loggedInShops.length, shopIds.size, shopAccountNum, accountNum);

  return {
    type: 'doudian.stdout.business_signal',
    shopIds: [...shopIds],
    loggedInShops,
    stdoutAccounts,
    accountIdsMasked: [...accountIdsMasked],
    apiSignals: [...apiSignals],
    pigeonApiSignals,
    loggedInShopCount,
    accountNum,
    shopAccountNum,
  };
}

function sanitizeUrlForReport(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url).split('?')[0].slice(0, 120);
  }
}

module.exports = {
  parseStdoutBusinessSignals,
  extractLoggedInShopsFromStdout,
  parseStdoutAccountsFromLine,
  redactStdoutLine,
  redactSensitiveFields,
};
