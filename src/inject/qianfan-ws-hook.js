/**
 * 页面内 WebSocket hook — 只观测，不阻断。
 * 命名空间: window.__QF_CDP_BRIDGE__ / window.__QF_CDP_BRIDGE_INSTALLED__
 */
(function () {
  'use strict';
  if (window.__QF_CDP_BRIDGE_INSTALLED__) return;
  window.__QF_CDP_BRIDGE_INSTALLED__ = true;

  var NS = (window.__QF_CDP_BRIDGE__ = window.__QF_CDP_BRIDGE__ || {});
  NS.version = '1.0.0';
  NS.sockets = NS.sockets || [];
  NS.events = NS.events || [];
  NS.maxEvents = 500;

  function safeEmit(evt) {
    try {
      NS.events.push(evt);
      if (NS.events.length > NS.maxEvents) NS.events.shift();
      if (typeof window.__QF_BRIDGE_EMIT__ === 'function') {
        window.__QF_BRIDGE_EMIT__(JSON.stringify(evt));
      }
    } catch (e) {
      /* swallow */
    }
  }

  function summarizePayload(data) {
    try {
      if (data == null) return { payloadType: 'null', payloadText: '', payloadBase64: '' };
      if (typeof data === 'string') {
        return { payloadType: 'string', payloadText: data.slice(0, 20000), payloadBase64: '' };
      }
      if (data instanceof ArrayBuffer) {
        var bytes = new Uint8Array(data);
        var bin = '';
        var len = Math.min(bytes.length, 4096);
        for (var i = 0; i < len; i++) bin += String.fromCharCode(bytes[i]);
        return {
          payloadType: 'arraybuffer',
          payloadText: '[arraybuffer:' + bytes.length + ']',
          payloadBase64: btoa(bin).slice(0, 8000),
        };
      }
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        return { payloadType: 'blob', payloadText: '[blob:' + (data.size || 0) + ']', payloadBase64: '' };
      }
      return { payloadType: typeof data, payloadText: String(data).slice(0, 2000), payloadBase64: '' };
    } catch (e) {
      return { payloadType: 'error', payloadText: '[payload-error]', payloadBase64: '' };
    }
  }

  function nextSocketId() {
    NS._socketSeq = (NS._socketSeq || 0) + 1;
    return 'ws-' + Date.now() + '-' + NS._socketSeq;
  }

  function trackSocket(ws, url, protocols) {
    try {
      var socketId = nextSocketId();
      Object.defineProperty(ws, '__qfSocketId', { value: socketId, enumerable: false, configurable: true });
      NS.sockets.push({ socketId: socketId, url: url, protocol: protocols, openedAt: Date.now() });
      safeEmit({
        kind: 'ws_open',
        socketId: socketId,
        url: url,
        direction: 'meta',
        timestamp: Date.now(),
      });
      ws.addEventListener('message', function (ev) {
        var p = summarizePayload(ev.data);
        safeEmit({
          kind: 'ws_message',
          socketId: socketId,
          url: url,
          direction: 'in',
          timestamp: Date.now(),
          payloadType: p.payloadType,
          payloadText: p.payloadText,
          payloadBase64: p.payloadBase64,
        });
      });
      ws.addEventListener('close', function () {
        safeEmit({ kind: 'ws_close', socketId: socketId, url: url, direction: 'meta', timestamp: Date.now() });
      });
      ws.addEventListener('error', function () {
        safeEmit({ kind: 'ws_error', socketId: socketId, url: url, direction: 'meta', timestamp: Date.now() });
      });
    } catch (e) {
      /* swallow */
    }
  }

  try {
    var OriginalWebSocket = window.WebSocket;
    if (!OriginalWebSocket || OriginalWebSocket.__qfHooked) return;

    function HookedWebSocket(url, protocols) {
      var ws = protocols !== undefined ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
      try {
        trackSocket(ws, String(url || ''), protocols);
        var origSend = ws.send;
        ws.send = function (data) {
          try {
            var p = summarizePayload(data);
            safeEmit({
              kind: 'ws_send',
              socketId: ws.__qfSocketId || '',
              url: String(url || ''),
              direction: 'out',
              timestamp: Date.now(),
              payloadType: p.payloadType,
              payloadText: p.payloadText,
              payloadBase64: p.payloadBase64,
            });
          } catch (e) {
            /* swallow */
          }
          return origSend.apply(ws, arguments);
        };
      } catch (e) {
        /* swallow */
      }
      return ws;
    }

    HookedWebSocket.prototype = OriginalWebSocket.prototype;
    HookedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    HookedWebSocket.OPEN = OriginalWebSocket.OPEN;
    HookedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
    HookedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
    HookedWebSocket.__qfHooked = true;
    window.WebSocket = HookedWebSocket;
  } catch (e) {
    /* restore silently — hook failed */
  }
})();
