/**
 * 生成注入到 preload 的 UI 噪音过滤 + IPC memory cache hook 代码
 */
function buildUiNoiseFilterBrowserCode() {
  return `
    var UI_NOISE_EXACT = {
      '在线':1,'三方':1,'商家后台':1,'AI智能客服':1,'挽单方案配置':1,'当前会话':1,'最近联系':1,
      '列表设置':1,'等待时长':1,'已分组':1,'首页':1,'接待':1,'通知':1,'待发货':1,'售后':1,
      '暂无会话中用户':1,'请选择会话':1,'与消费者聊天':1,'您今日暂无接待数据':1,'抖店':1,'飞鸽客服系统':1,
      '加载中...':1,'加载中':1
    };
    var UI_NOISE_PARTIAL = ['AI智能客服','挽单方案配置','开启场景后','当前会话','最近联系','商家后台','列表设置','等待时长','暂无会话','请选择会话','挽单工具','售后挽单','加载中','智能客服'];
    function normalizeUiText(text) { return safeString(text).replace(/\\s+/g, ' ').trim(); }
    function isSingleLineUiNoise(text) {
      var s = normalizeUiText(text);
      if (!s || s.length < 2) return true;
      if (UI_NOISE_EXACT[s]) return true;
      for (var i = 0; i < UI_NOISE_PARTIAL.length; i++) {
        var p = UI_NOISE_PARTIAL[i];
        if (s === p || s.indexOf(p) === 0) return true;
      }
      if (s.length <= 4 && /^(在线|三方|首页|接待|通知|售后)$/.test(s)) return true;
      if (/^《.+》$/.test(s)) return true;
      if (/^加载中/.test(s)) return true;
      return false;
    }
    function isUiNoise(text) {
      var raw = safeString(text);
      if (raw.indexOf('\\n') >= 0) {
        var lines = raw.split(/\\r?\\n/).map(function (l) { return normalizeUiText(l); }).filter(Boolean);
        if (!lines.length) return true;
        var noisy = 0;
        for (var li = 0; li < lines.length; li++) {
          if (isSingleLineUiNoise(lines[li])) noisy++;
        }
        if (noisy === lines.length) return true;
        if (lines.length >= 2 && noisy >= Math.ceil(lines.length * 0.7)) return true;
      }
      return isSingleLineUiNoise(raw);
    }
    function emitUiNoiseSample(text) {
      send('doudian.ui.noise', { text: normalizeUiText(text).slice(0, 120), timestamp: Date.now() });
    }
`;
}

function buildMemoryCacheHookBrowserCode() {
  return `
    var SKIP_PAYLOAD_KEYS = /cookie|token|csrf|authorization|ticket|sign|x-ms-token|bd-ticket|session-sign|password|secret/i;

    function resolveApiNameFromKey(key) {
      var u = safeString(key).toLowerCase();
      if (u.indexOf('currentuser') >= 0) return 'currentuser';
      if (u.indexOf('get_current_conversation_list') >= 0) return 'get_current_conversation_list';
      if (u.indexOf('get_link_info') >= 0) return 'get_link_info';
      if (u.indexOf('conversation') >= 0) return 'conversation';
      if (u.indexOf('message') >= 0) return 'message';
      return 'unknown';
    }

    function sanitizePayloadForBridge(obj, depth, counter) {
      if (!obj || depth > 6 || counter.n > 3000) return null;
      counter.n++;
      if (Array.isArray(obj)) {
        var arr = [];
        for (var i = 0; i < obj.length && i < 100; i++) {
          var c = sanitizePayloadForBridge(obj[i], depth + 1, counter);
          if (c != null) arr.push(c);
        }
        return arr;
      }
      if (typeof obj !== 'object') {
        if (typeof obj === 'string') return obj.slice(0, 1000);
        if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
        return null;
      }
      var out = {};
      for (var k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        if (SKIP_PAYLOAD_KEYS.test(k)) continue;
        var val = obj[k];
        if (val == null) continue;
        if (typeof val === 'string') out[k] = val.slice(0, 1000);
        else if (typeof val === 'number' || typeof val === 'boolean') out[k] = val;
        else if (typeof val === 'object') {
          var child = sanitizePayloadForBridge(val, depth + 1, counter);
          if (child != null) out[k] = child;
        }
      }
      return out;
    }

    function buildConversationRow(row) {
      if (!row || typeof row !== 'object') return null;
      var convId = pickFirst(row.conversationId, row.conversation_id, row.conversation_short_id);
      var buyerId = pickFirst(row.buyerId, row.buyer_id, row.userId, row.user_id);
      var buyerName = pickFirst(row.buyerName, row.nickName, row.nickname, row.name);
      var text = pickFirst(row.content, row.text, row.msg, row.message, row.last_message);
      if (!convId && !buyerId && !buyerName) return null;
      return {
        conversationId: convId,
        buyerId: buyerId,
        buyerName: buyerName,
        lastMessageText: maskSensitiveText(safeString(text).slice(0, 200)),
        lastMessageTime: Number(pickFirst(row.sendTime, row.createTime, row.timestamp)) || 0,
        unreadCount: Number(pickFirst(row.unread, row.unreadCount, row.unread_count)) || 0,
        status: pickFirst(row.status, row.state),
        rawTextHash: hashText(text || buyerName || convId),
      };
    }

    function inferApiNameFromPayload(payload, key) {
      var fromKey = resolveApiNameFromKey(key);
      if (fromKey !== 'unknown') return fromKey;
      try {
        var data = payload && (payload.data || payload.result || payload);
        if (data && data.shop && (data.shop.shop_id || data.shop.shopId || data.shop.shop_name || data.shop.shopName)) {
          return 'currentuser';
        }
        if (data && Array.isArray(data.list)) return 'get_current_conversation_list';
        if (Array.isArray(payload)) return 'get_current_conversation_list';
        if (data && Array.isArray(data.messages)) return 'message';
        if (data && data.link_info) return 'get_link_info';
      } catch (e) {}
      return fromKey;
    }

    function extractPartitionFromCacheKey(key) {
      var k = safeString(key);
      var m = k.match(/persist:\\d{10,20}/);
      return m ? m[0] : '';
    }

    function emitMemoryCacheCandidate(cacheKey, result) {
      var key = safeString(cacheKey);
      if (!key) return;
      var payload = null;
      try {
        payload = typeof result === 'string' ? JSON.parse(result) : result;
      } catch (e) {
        payload = null;
      }
      var apiName = inferApiNameFromPayload(payload, key);
      var shopInfo = { shopId: '', shopName: '', accountId: '', sessionPartitionKey: '' };
      var conversationCount = 0;
      var messageCount = 0;
      var items = [];
      var conversations = [];
      var messages = [];
      var safePayload = '';
      var source = 'memory_cache';
      try {
        if (!payload) payload = typeof result === 'string' ? JSON.parse(result) : result;
        var bag = {};
        shallowExtract(payload, 0, { n: 0 }, bag);
        shopInfo = {
          shopId: pickFirst(bag.shopId, bag.shop_id, shopCache.shopId),
          shopName: pickFirst(bag.shopName, bag.shop_name, shopCache.shopName),
          accountId: pickFirst(bag.accountId, bag.account_id),
          sessionPartitionKey: pickFirst(bag.sessionPartitionKey, bag.session_partition_key),
        };
        var partFromKey = extractPartitionFromCacheKey(key);
        if (partFromKey) {
          if (!shopInfo.sessionPartitionKey) shopInfo.sessionPartitionKey = partFromKey;
          if (!shopInfo.accountId) shopInfo.accountId = partFromKey.replace(/^persist:/, '');
        }
        applyShopFromBag(bag, 'memory_cache');
        try {
          var safeObj = sanitizePayloadForBridge(payload, 0, { n: 0 });
          if (safeObj) {
            safePayload = JSON.stringify(safeObj);
            if (safePayload.length > 120000) safePayload = safePayload.slice(0, 120000);
          }
        } catch (e) {}

        function collectRows(arr) {
          if (!Array.isArray(arr)) return;
          for (var i = 0; i < arr.length && i < 50; i++) {
            var row = buildConversationRow(arr[i]);
            if (row) {
              conversations.push(row);
              items.push({
                conversationId: row.conversationId,
                buyerId: row.buyerId,
                buyerName: row.buyerName,
              });
            }
          }
        }

        if (Array.isArray(payload)) {
          conversationCount = payload.length;
          collectRows(payload);
        } else if (payload && typeof payload === 'object') {
          var data = payload.data || payload.result || payload;
          if (Array.isArray(data)) {
            conversationCount = data.length;
            collectRows(data);
          } else if (data && Array.isArray(data.list)) {
            conversationCount = data.list.length;
            collectRows(data.list);
          }
          if (data && Array.isArray(data.messages)) {
            for (var mi = 0; mi < data.messages.length && mi < 30; mi++) {
              var mrow = data.messages[mi];
              if (!mrow || typeof mrow !== 'object') continue;
              var mtext = pickFirst(mrow.content, mrow.text, mrow.msg, mrow.message);
              if (!mtext || isUiNoise(mtext)) continue;
              messages.push({
                conversationId: pickFirst(mrow.conversationId, mrow.conversation_id),
                buyerId: pickFirst(mrow.buyerId, mrow.buyer_id, mrow.userId, mrow.user_id),
                buyerName: pickFirst(mrow.buyerName, mrow.nickName, mrow.nickname, mrow.name),
                messageId: pickFirst(mrow.messageId, mrow.message_id, mrow.serverMessageId),
                direction: 'buyer',
                messageType: 'text',
                text: maskSensitiveText(safeString(mtext).slice(0, 500)),
                timestamp: Number(pickFirst(mrow.sendTime, mrow.createTime, mrow.timestamp)) || Date.now(),
                rawTextHash: hashText(mtext),
              });
            }
            messageCount = messages.length;
          }
        }
      } catch (e) {}

      send('doudian.memory_cache.candidate', {
        cacheKey: sanitizeUrl(key),
        apiName: apiName,
        shopInfo: shopInfo,
        shopId: shopInfo.shopId,
        shopName: shopInfo.shopName,
        accountId: shopInfo.accountId,
        sessionPartitionKey: shopInfo.sessionPartitionKey,
        conversationCount: conversationCount,
        messageCount: messageCount,
        items: items.slice(0, 10),
        bridgeType: 'preload_ipc',
        safePayload: safePayload,
        source: source,
      });

      if (apiName === 'currentuser' && (shopInfo.shopId || shopInfo.shopName || shopInfo.accountId)) {
        send('doudian.shop.identity_resolved', { source: source, shopInfo: shopInfo });
      }

      if (apiName === 'get_current_conversation_list') {
        if (conversationCount === 0 || conversations.length === 0) {
          send('doudian.conversation.empty', {
            source: source,
            shopInfo: shopInfo,
            reason: 'conversation_list_empty',
            cacheKey: sanitizeUrl(key),
          });
        } else {
          send('doudian.conversation.list', {
            source: source,
            shopInfo: shopInfo,
            conversationCount: conversations.length,
            conversations: conversations.slice(0, 50),
          });
        }
      }

      if (messages.length > 0) {
        send('doudian.message.real_candidate', {
          source: source,
          shopInfo: shopInfo,
          items: messages.slice(0, 30),
        });
      }
    }

    function installIpcMemoryCacheHook() {
      try {
        if (typeof require === 'undefined') return;
        var electron = require('electron');
        var ipc = electron && electron.ipcRenderer;
        if (!ipc || ipc.__doudianMemoryHook) return;
        var origInvoke = ipc.invoke.bind(ipc);
        ipc.invoke = function (channel) {
          var args = Array.prototype.slice.call(arguments, 1);
          var ret = origInvoke.apply(ipc, arguments);
          if (channel === 'getMemoryCacheData' || channel === 'getMemoryCacheDataWithTimeout') {
            return ret.then(function (result) {
              try { emitMemoryCacheCandidate(args[0], result); } catch (e) {}
              return result;
            });
          }
          return ret;
        };
        ipc.__doudianMemoryHook = true;
      } catch (e) {}
    }
`;
}

module.exports = {
  buildUiNoiseFilterBrowserCode,
  buildMemoryCacheHookBrowserCode,
};
