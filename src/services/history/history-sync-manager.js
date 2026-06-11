const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ensureDir, resolveLogsDir } = require('../../shared/app-root');
const { getHistorySyncConfig } = require('../../shared/config');
const { historyLog } = require('../../shared/history-log');
const { ensureDebugClientReady } = require('../runtime/ensure-debug-client-ready');
const { CdpClient } = require('../cdp/cdp-client');
const { HistoryDb } = require('./history-db');
const { HistoryCdpPage } = require('./history-cdp-page');
const { HistoryNetworkSniffer } = require('./history-network-sniffer');
const { HistoryApiClient } = require('./history-api-client');
const { HistoryDomFallback } = require('./history-dom-fallback');

function makeRunId() {
  return `hist-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function computeLookbackDays(db, cfg) {
  if (!db.hasAnyMessages()) return cfg.firstRunLookbackDays || 7;
  return cfg.defaultLookbackDays || 3;
}

function writeSyncReport(report) {
  const dir = ensureDir(resolveLogsDir());
  const jsonPath = path.join(dir, 'history-sync-latest.json');
  const txtPath = path.join(dir, 'history-sync-latest.txt');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  const lines = [
    '历史消息补拉报告',
    '',
    '一、运行状态',
    `- 状态: ${report.status}`,
    `- runId: ${report.runId}`,
    `- 开始时间: ${report.startTime}`,
    `- 结束时间: ${report.endTime}`,
    '',
    '二、客户端复用状态',
    `- 是否检测到进程: ${report.clientReuse?.processDetected}`,
    `- 是否检测到 DevTools 端口: ${Boolean(report.clientReuse?.devtoolsPort)}`,
    `- 是否复用现有窗口: ${report.clientReuse?.reusedExistingClient}`,
    `- 是否执行了 taskkill: ${report.clientReuse?.killedExistingClient}`,
    `- 是否重新启动客户端: ${report.clientReuse?.relaunchedClient}`,
    `- reusedExistingClient: ${report.clientReuse?.reusedExistingClient}`,
    `- killedExistingClient: ${report.clientReuse?.killedExistingClient}`,
    `- relaunchedClient: ${report.clientReuse?.relaunchedClient}`,
    '',
    '三、CDP 状态',
    `- version: ${report.cdp?.versionUrl || '-'}`,
    `- list: ${report.cdp?.listUrl || '-'}`,
    `- target 数量: ${report.cdp?.targetCount || 0}`,
    ...(report.cdp?.matchedTargets || []).map((t) => `- ${t.title} | ${t.url}`),
    '',
    '四、页面状态',
    `- CDP 连接: ${report.page?.connected}`,
    `- 飞鸽/抖店页面: ${report.page?.foundImPage}`,
    `- 历史会话页面: ${report.page?.openedHistoryPage}`,
    `- 登录: ${report.page?.loggedIn}`,
    `- 权限: ${report.page?.hasPermission}`,
    '',
    '五、接口识别',
    `- 候选接口数: ${report.api?.candidateCount || 0}`,
    `- 会话列表: ${report.api?.conversationListUrl || '-'}`,
    `- 消息列表: ${report.api?.messageListUrl || '-'}`,
    `- 分页参数: ${(report.api?.paginationHints || []).join(', ') || '-'}`,
    `- 时间参数: ${(report.api?.timeHints || []).join(', ') || '-'}`,
    `- cookie 可复用: ${report.api?.cookiesAvailable}`,
    '',
    '六、补拉结果',
    `- 店铺数: ${report.results?.shopCount || 0}`,
    `- 会话数: ${report.results?.conversationCount || 0}`,
    `- 新增消息: ${report.results?.insertedMessages || 0}`,
    `- 重复消息: ${report.results?.skippedDuplicates || 0}`,
    `- 失败数: ${report.results?.errorCount || 0}`,
    '',
    '七、数据库写入',
    `- conversations: ${report.db?.conversations || 0}`,
    `- messages: ${report.db?.messages || 0}`,
    `- 去重: shopId+msgId / conversationId+sendTime+contentHash`,
    '',
    '八、失败原因',
    ...(report.failures || []).map((f) => `- ${f}`),
    ...(report.suggestions || []).map((s) => `- 建议: ${s}`),
  ];
  fs.writeFileSync(txtPath, lines.join('\n'), 'utf8');
  return { jsonPath, txtPath };
}

class HistorySyncManager {
  constructor(options = {}) {
    this.cfg = { ...getHistorySyncConfig(), ...(options.historySync || {}) };
    this.db = options.db || new HistoryDb();
    this.lastReport = null;
    this.historySyncStatus = 'idle';
  }

  async runInspect(options = {}) {
    return this.run({ mode: 'inspect', ...options });
  }

  async runSync(options = {}) {
    return this.run({ mode: 'sync', ...options });
  }

  async run(options = {}) {
    const mode = options.mode || 'sync';
    const runId = makeRunId();
    const startTime = new Date().toISOString();
    const listenMs = Number(options.listenMs || (mode === 'inspect' ? 15000 : 12000));

    historyLog('[HISTORY_SYNC]', `start mode=${mode} runId=${runId}`);

    const report = {
      runId,
      mode,
      startTime,
      endTime: '',
      status: 'failed',
      clientReuse: {},
      cdp: {},
      page: {},
      api: {},
      results: {},
      db: {},
      failures: [],
      suggestions: [],
    };

    const clientReady = await ensureDebugClientReady(options);
    report.clientReuse = {
      processDetected: clientReady.processDetected,
      devtoolsPort: clientReady.devtoolsPort,
      reusedExistingClient: clientReady.reusedExistingClient,
      killedExistingClient: clientReady.killedExistingClient,
      relaunchedClient: clientReady.relaunchedClient,
      reason: clientReady.reason,
      message: clientReady.message,
    };

    this.db.startRun({
      runId,
      reusedExistingClient: clientReady.reusedExistingClient,
      killedExistingClient: clientReady.killedExistingClient,
      relaunchedClient: clientReady.relaunchedClient,
    });

    if (!clientReady.ready) {
      report.failures.push(clientReady.message || clientReady.reason || 'client_not_ready');
      report.suggestions.push('请用 --remote-debugging-port=9222 调试模式启动抖店/千帆，并打开 IM 客服页。');
      report.endTime = new Date().toISOString();
      report.status = 'failed';
      this.historySyncStatus = 'failed';
      this.db.setStatus('historySyncStatus', 'failed');
      this.db.setStatus('historyReady', 'false');
      this.db.finishRun(runId, { status: 'failed', errorCount: 1, reportPath: '' });
      const paths = writeSyncReport(report);
      report.reportPaths = paths;
      this.lastReport = report;
      return report;
    }

    report.cdp = {
      versionUrl: clientReady.versionUrl,
      listUrl: clientReady.listUrl,
      targetCount: clientReady.targetCount,
      matchedTargets: (clientReady.matchedTargets || []).map((t) => ({
        targetId: t.targetId,
        title: t.title,
        url: t.url,
        shopId: t.shopId,
        shopName: t.shopName,
      })),
    };

    const target = clientReady.matchedTargets[0];
    const client = new CdpClient({
      wsUrl: target.webSocketDebuggerUrl,
      targetId: target.targetId,
      label: target.title || target.targetId,
    });

    let sniffer = null;
    try {
      await client.connect();
      const page = new HistoryCdpPage(client, target);
      const pageResult = await page.ensureHistoryPage();
      report.page = page.getState();

      if (!pageResult.ok) {
        report.failures.push(pageResult.reason || 'history_page_not_ready');
        if (!pageResult.pageState?.loggedIn) {
          report.suggestions.push('页面未登录或权限不足，请在本机客服台完成登录后再运行。');
        }
      }

      const pageMeta = page.getPageMeta();
      sniffer = new HistoryNetworkSniffer(client);
      await sniffer.listen(listenMs);
      const candidates = sniffer.getCandidates();
      const candidatePaths = sniffer.saveReports({ force: mode === 'inspect' });

      report.api = {
        candidateCount: candidates.length,
        conversationListUrl: sniffer.getBestByKind('conversation_list')?.url || '',
        messageListUrl: sniffer.getBestByKind('message_list')?.url || '',
        paginationHints: candidates.flatMap((c) => c.paginationHints || []).slice(0, 10),
        timeHints: candidates.flatMap((c) => c.timeHints || []).slice(0, 10),
        cookiesAvailable: false,
        candidateReportPaths: candidatePaths,
      };

      if (mode === 'inspect') {
        report.status = candidates.length ? 'success' : 'partial';
        if (!candidates.length) {
          report.failures.push('未识别到历史会话相关接口');
          report.suggestions.push('请在历史会话页切换会话/滚动列表，再运行 history:inspect。');
          report.suggestions.push('如仍无候选接口，请提供 DevTools Network 里 history/conversation 请求样本。');
        }
        report.endTime = new Date().toISOString();
        this.historySyncStatus = candidates.length ? 'inspect_ok' : 'inspect_empty';
        this.db.finishRun(runId, { status: report.status, reportPath: candidatePaths?.txtPath || '' });
        const paths = writeSyncReport(report);
        report.reportPaths = paths;
        this.lastReport = report;
        return report;
      }

      let inserted = 0;
      let skipped = 0;
      let scannedConversations = 0;
      let errorCount = 0;

      const lookbackDays = computeLookbackDays(this.db, this.cfg);
      historyLog('[HISTORY_SYNC]', `lookbackDays=${lookbackDays}`);

      if (this.cfg.preferApi !== false && candidates.length) {
        const apiClient = new HistoryApiClient(client, { pageMeta });
        report.api.cookiesAvailable = await apiClient.loadCookies();
        const pulled = await apiClient.pullFromCandidates(candidates, {
          shopId: target.shopId,
          shopName: target.shopName,
          platform: target.platform,
        });

        for (const conv of pulled.conversations || []) {
          scannedConversations += 1;
          try {
            this.db.upsertConversation(conv);
          } catch (err) {
            errorCount += 1;
            this.db.insertError(runId, 'history-db', 'upsertConversation failed', err.message);
          }
        }

        for (const msg of pulled.messages || []) {
          try {
            const r = this.db.insertMessage(msg);
            if (r.inserted) inserted += 1;
            else skipped += 1;
          } catch (err) {
            errorCount += 1;
            this.db.insertError(runId, 'history-db', 'insertMessage failed', err.message);
          }
        }
      }

      if ((inserted === 0) && this.cfg.enableDomFallback !== false) {
        historyLog('[HISTORY_SYNC]', 'API pull empty, trying DOM fallback');
        const dom = new HistoryDomFallback(client, pageMeta);
        const domResult = await dom.extract();
        for (const conv of domResult.conversations || []) {
          scannedConversations += 1;
          try {
            this.db.upsertConversation({ ...conv, shopId: target.shopId, shopName: target.shopName });
          } catch (err) {
            errorCount += 1;
          }
        }
        for (const msg of domResult.messages || []) {
          try {
            const r = this.db.insertMessage(msg);
            if (r.inserted) inserted += 1;
            else skipped += 1;
          } catch (err) {
            errorCount += 1;
          }
        }
        if (!domResult.ok) report.failures.push('DOM fallback extracted no trusted messages');
      }

      if (inserted === 0 && !candidates.length) {
        report.failures.push('未识别接口且 DOM 未抽取到消息');
        report.suggestions.push('请打开飞鸽历史会话页并触发列表加载后重试。');
      }

      report.results = {
        shopCount: 1,
        conversationCount: scannedConversations,
        insertedMessages: inserted,
        skippedDuplicates: skipped,
        errorCount,
        lookbackDays,
      };
      report.db = {
        conversations: this.db.countConversations(),
        messages: this.db.countMessages(),
      };

      report.status = inserted > 0 ? 'success' : errorCount > 0 ? 'partial' : 'failed';
      if (inserted > 0 && errorCount > 0) report.status = 'partial';

      this.historySyncStatus = report.status === 'failed' ? 'failed' : 'ready';
      this.db.setStatus('historySyncStatus', this.historySyncStatus);
      this.db.setStatus('historyReady', inserted > 0 ? 'true' : 'false');

      report.endTime = new Date().toISOString();
      const paths = writeSyncReport(report);
      report.reportPaths = paths;

      this.db.finishRun(runId, {
        status: report.status,
        endTime: report.endTime,
        scannedConversations,
        insertedMessages: inserted,
        skippedDuplicates: skipped,
        errorCount,
        reportPath: paths.txtPath,
      });

      historyLog('[HISTORY_SYNC]', `done status=${report.status} inserted=${inserted}`);
      this.lastReport = report;
      return report;
    } catch (err) {
      report.failures.push(String(err.message || err));
      report.endTime = new Date().toISOString();
      report.status = 'failed';
      this.historySyncStatus = 'failed';
      this.db.setStatus('historySyncStatus', 'failed');
      this.db.setStatus('historyReady', 'false');
      this.db.insertError(runId, 'history-sync-manager', 'run failed', err.message);
      this.db.finishRun(runId, { status: 'failed', errorCount: 1 });
      const paths = writeSyncReport(report);
      report.reportPaths = paths;
      this.lastReport = report;
      historyLog('[HISTORY_ERROR]', 'history sync failed', err.message);
      return report;
    } finally {
      sniffer?.dispose();
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
  }

  getStatus() {
    return {
      historySyncStatus: this.historySyncStatus,
      historyReady: this.db.getStatus('historyReady', 'false') === 'true',
      lastReport: this.lastReport,
    };
  }
}

module.exports = {
  HistorySyncManager,
  writeSyncReport,
};
