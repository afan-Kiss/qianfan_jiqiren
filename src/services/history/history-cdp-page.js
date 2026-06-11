const { historyLog } = require('../../shared/history-log');
const { getHistorySyncConfig } = require('../../shared/config');

const HISTORY_URL_KEYWORDS = ['historyconversation', 'pc_seller_v2', 'main/data', 'im.jinritemai.com'];
const DEFAULT_HISTORY_PATH = '/pc_seller_v2/main/data/historyConversation';

function isHistoryPageUrl(url = '') {
  const u = String(url).toLowerCase();
  if (u.includes('historyconversation')) return true;
  if (u.includes('im.jinritemai.com') && u.includes('history')) return true;
  if (u.includes('main/data') && (u.includes('history') || u.includes('conversation'))) return true;
  return false;
}

function isImPageUrl(url = '') {
  const u = String(url).toLowerCase();
  return u.includes('im.jinritemai.com') || u.includes('pigeon') || u.includes('fxg.jinritemai.com');
}

function buildHistoryUrl(target) {
  const base = 'https://im.jinritemai.com';
  return `${base}${DEFAULT_HISTORY_PATH}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class HistoryCdpPage {
  constructor(client, target, options = {}) {
    this.client = client;
    this.target = target;
    this.options = options;
    this.pageState = {
      connected: false,
      foundImPage: false,
      openedHistoryPage: false,
      loggedIn: false,
      hasPermission: false,
      pageUrl: target.pageUrl || target.url || '',
      pageTitle: target.pageTitle || target.title || '',
    };
  }

  async connect() {
    await this.client.send('Page.enable');
    await this.client.send('Runtime.enable');
    this.pageState.connected = true;
    historyLog('[HISTORY_PAGE]', `CDP connected target=${this.target.targetId}`);
    return true;
  }

  async detectLoginState() {
    try {
      const res = await this.client.send('Runtime.evaluate', {
        expression: `(function(){
          var href = location.href || '';
          var body = document.body ? document.body.innerText.slice(0, 500) : '';
          var loggedIn = !/登录|请登录|扫码登录|验证码登录/.test(body + document.title);
          var hasIm = /im\\.jinritemai|history|conversation|会话|消息/.test(href + document.title);
          return { href, title: document.title, loggedIn, hasIm, bodyPreview: body.slice(0, 120) };
        })()`,
        returnByValue: true,
      });
      const val = res?.result?.value || {};
      this.pageState.loggedIn = Boolean(val.loggedIn);
      this.pageState.hasPermission = Boolean(val.hasIm);
      this.pageState.pageUrl = val.href || this.pageState.pageUrl;
      this.pageState.pageTitle = val.title || this.pageState.pageTitle;
      this.pageState.foundImPage = isImPageUrl(this.pageState.pageUrl);
      historyLog('[HISTORY_PAGE]', `login=${this.pageState.loggedIn} im=${this.pageState.foundImPage}`);
      return this.pageState;
    } catch (err) {
      historyLog('[HISTORY_ERROR]', '[HISTORY_PAGE] detectLoginState failed', String(err.message || err));
      return this.pageState;
    }
  }

  async ensureHistoryPage() {
    await this.connect();
    await this.detectLoginState();

    if (!this.pageState.loggedIn) {
      historyLog('[HISTORY_PAGE]', 'not logged in, stop');
      return { ok: false, reason: 'not_logged_in', pageState: this.pageState };
    }

    if (isHistoryPageUrl(this.pageState.pageUrl)) {
      this.pageState.openedHistoryPage = true;
      historyLog('[HISTORY_PAGE]', 'reuse existing history page');
      return { ok: true, reused: true, pageState: this.pageState };
    }

    if (this.pageState.foundImPage || isImPageUrl(this.target.url)) {
      const historyUrl = buildHistoryUrl(this.target);
      historyLog('[HISTORY_PAGE]', `navigate to history page ${historyUrl.slice(0, 80)}`);
      try {
        await this.client.send('Page.navigate', { url: historyUrl });
        await sleep(3000);
        await this.detectLoginState();
        this.pageState.openedHistoryPage = isHistoryPageUrl(this.pageState.pageUrl) || this.pageState.hasPermission;
        return {
          ok: this.pageState.openedHistoryPage || this.pageState.foundImPage,
          reused: false,
          navigated: true,
          pageState: this.pageState,
        };
      } catch (err) {
        historyLog('[HISTORY_ERROR]', '[HISTORY_PAGE] navigate failed', String(err.message || err));
        return { ok: false, reason: 'navigate_failed', pageState: this.pageState };
      }
    }

    historyLog('[HISTORY_PAGE]', 'no im page found, using current target as fallback');
    this.pageState.openedHistoryPage = this.pageState.foundImPage;
    return { ok: this.pageState.foundImPage, reason: this.pageState.foundImPage ? 'im_page_fallback' : 'no_im_page', pageState: this.pageState };
  }

  getPageMeta() {
    return {
      targetId: this.target.targetId,
      pageUrl: this.pageState.pageUrl,
      pageTitle: this.pageState.pageTitle,
      shopId: this.target.shopId,
      shopName: this.target.shopName,
      platform: this.target.platform,
    };
  }

  getState() {
    return { ...this.pageState };
  }
}

module.exports = {
  HistoryCdpPage,
  isHistoryPageUrl,
  isImPageUrl,
  buildHistoryUrl,
  HISTORY_URL_KEYWORDS,
};
