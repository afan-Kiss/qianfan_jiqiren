#!/usr/bin/env node
/**
 * npm run doudian:test-parser-fixture
 */
const fs = require('fs');
const path = require('path');
const { parsePigeonPayload, createMockFixtures } = require('../src/platforms/doudian/doudian-pigeon-parser');
const { DoudianDedupe } = require('../src/platforms/doudian/doudian-dedupe');
const { DoudianBusinessPipeline } = require('../src/platforms/doudian/doudian-business-pipeline');
const { DOUDIAN_EVENTS } = require('../src/platforms/doudian/doudian-types');
const { closeDb } = require('../src/platforms/doudian/doudian-data-store');

const REPORT_PATH = path.join(process.cwd(), 'logs', 'doudian-parser-fixture-latest.json');
const FIXTURE_REPORT = path.join(process.cwd(), 'logs', 'doudian-auto-verify-listen-latest.json');

function loadListenSamples() {
  if (!fs.existsSync(FIXTURE_REPORT)) return [];
  try {
    const report = JSON.parse(fs.readFileSync(FIXTURE_REPORT, 'utf8'));
    const events = report.listenResult?.events || report.events || [];
    return events.filter((e) => e?.type === 'doudian.memory_cache.candidate');
  } catch {
    return [];
  }
}

function runFixtureTests() {
  const fixtures = createMockFixtures();
  const dedupe = new DoudianDedupe();
  const pipeline = new DoudianBusinessPipeline({ dedupe });
  const verifyDb = path.join(process.cwd(), 'logs', 'doudian-parser-fixture.db');
  if (fs.existsSync(verifyDb)) fs.unlinkSync(verifyDb);
  closeDb();
  process.env.DOUDIAN_VERIFY_DB = verifyDb;

  const currentUser = parsePigeonPayload(fixtures.currentuser, {
    cacheKey: 'https://pigeon.jinritemai.com/backstage/currentuser',
  });
  const emptyList = parsePigeonPayload(fixtures.emptyConversationList, {
    cacheKey: 'https://pigeon.jinritemai.com/chat/api/backstage/conversation/get_current_conversation_list',
  });
  const convList = parsePigeonPayload(fixtures.conversationList, {
    cacheKey: 'https://pigeon.jinritemai.com/chat/api/backstage/conversation/get_current_conversation_list',
  });
  const msgPayload = parsePigeonPayload(fixtures.messagePayload, {
    cacheKey: 'https://pigeon.jinritemai.com/chat/api/backstage/message',
  });

  pipeline.processEnvelope({
    type: DOUDIAN_EVENTS.MEMORY_CACHE_CANDIDATE,
    bridgeId: 'fixture-bridge',
    payload: {
      cacheKey: 'https://pigeon.jinritemai.com/backstage/currentuser',
      apiName: 'currentuser',
      shopInfo: currentUser.shopInfo,
      safePayload: JSON.stringify(fixtures.currentuser),
      source: 'fixture',
    },
  });

  pipeline.processEnvelope({
    type: DOUDIAN_EVENTS.MEMORY_CACHE_CANDIDATE,
    bridgeId: 'fixture-bridge',
    payload: {
      cacheKey: 'https://pigeon.jinritemai.com/chat/api/backstage/conversation/get_current_conversation_list',
      apiName: 'get_current_conversation_list',
      shopInfo: convList.shopInfo,
      safePayload: JSON.stringify(fixtures.emptyConversationList),
      source: 'fixture',
    },
  });

  pipeline.processEnvelope({
    type: DOUDIAN_EVENTS.MEMORY_CACHE_CANDIDATE,
    bridgeId: 'fixture-bridge',
    payload: {
      cacheKey: 'https://pigeon.jinritemai.com/chat/api/backstage/conversation/get_current_conversation_list',
      apiName: 'get_current_conversation_list',
      shopInfo: convList.shopInfo,
      safePayload: JSON.stringify(fixtures.conversationList),
      source: 'fixture',
    },
  });

  pipeline.processEnvelope({
    type: DOUDIAN_EVENTS.MESSAGE_REAL_CANDIDATE,
    bridgeId: 'fixture-bridge',
    payload: {
      source: 'fixture',
      shopInfo: convList.shopInfo,
      items: msgPayload.messages,
    },
  });

  const dupMsg = { ...msgPayload.messages[0] };
  pipeline.processEnvelope({
    type: DOUDIAN_EVENTS.MESSAGE_REAL_CANDIDATE,
    bridgeId: 'fixture-bridge',
    payload: {
      source: 'fixture',
      shopInfo: convList.shopInfo,
      items: [dupMsg],
    },
  });

  const stats = pipeline.getStats();
  const listenSamples = loadListenSamples();

  const result = {
    parserOk: currentUser.ok && emptyList.ok && convList.ok && msgPayload.ok,
    shopParsed: Boolean(currentUser.shopInfo.shopId && currentUser.shopInfo.shopName),
    emptyConversationParsed: emptyList.emptyState.isEmpty && emptyList.conversations.length === 0,
    mockConversationParsed: convList.conversations.length >= 1,
    mockMessageParsed: msgPayload.messages.length >= 1,
    dedupeOk: stats.platformMessageInsertCount === 1,
    sqliteInsertOk: stats.platformMessageInsertCount >= 1 && stats.platformConversationUpsertCount >= 1,
    listenSampleCount: listenSamples.length,
    pipelineStats: stats,
    success:
      Boolean(currentUser.shopInfo.shopId) &&
      emptyList.emptyState.isEmpty &&
      convList.conversations.length >= 1 &&
      msgPayload.messages.length >= 1 &&
      stats.platformMessageInsertCount === 1 &&
      stats.platformConversationUpsertCount >= 1,
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify(result, null, 2));
  console.log(`报告: ${REPORT_PATH}`);

  closeDb();
  process.exit(result.success ? 0 : 1);
}

runFixtureTests();
