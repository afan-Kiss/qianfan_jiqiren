/**
 * 千帆 /message/send 文本 payload 构建
 */
const crypto = require('crypto');

function makeTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

function makeSMid() {
  return `${crypto.randomBytes(6).toString('hex')}-${Date.now().toString(16).slice(-12)}`;
}

function makeUuid() {
  return `text-${crypto.randomBytes(8).toString('hex')}-${Date.now().toString(16)}`;
}

function buildTextSendPayloadFromContext({ shopTitle, appCid, receiverAppUids, text, seq, sessionContext, manualTemplate }) {
  const traceId = makeTraceId();
  const sMid = makeSMid();
  const uuid = makeUuid();
  const safeSeq = Number(seq) > 0 ? Number(seq) : 1;
  const uids = Array.isArray(receiverAppUids) ? receiverAppUids.filter(Boolean) : [];

  let payload;

  if (manualTemplate?.payload) {
    payload = JSON.parse(JSON.stringify(manualTemplate.payload));
    payload.header = payload.header || {};
    payload.body = payload.body || {};
    payload.header.sTime = Date.now();
    payload.header.seq = safeSeq;
    payload.header.type = 3;
    payload.header.bizId = payload.header.bizId || 10;
    payload.header.contentType = 'json';
    payload.header.traceId = traceId;
    payload.header.action = '/message/send';
    payload.header.serviceId = 'impaas.oi';
    payload.header.oneWay = false;
    payload.header.sMid = sMid;
    payload.body.appCid = appCid;
    payload.body.convType = payload.body.convType || 1;
    payload.body.uuid = uuid;
    payload.body.receiverAppUids = uids;
    const ci = manualTemplate.payload?.body?.contentInfo || { contentType: 1 };
    payload.body.contentInfo = {
      ...ci,
      contentType: ci.contentType || 1,
      content: text,
    };
    if (payload.body.extension?.additionInfo) {
      try {
        const info = JSON.parse(payload.body.extension.additionInfo);
        info.uuid = crypto.randomUUID();
        payload.body.extension.additionInfo = JSON.stringify(info);
      } catch {
        payload.body.extension.additionInfo = JSON.stringify({
          uuid: crypto.randomUUID(),
          sendMsgDoubleCheck: false,
        });
      }
    }
  } else {
    payload = {
      header: {
        sTime: Date.now(),
        seq: safeSeq,
        type: 3,
        bizId: 10,
        contentType: 'json',
        traceId,
        action: '/message/send',
        serviceId: 'impaas.oi',
        oneWay: false,
        sMid,
      },
      body: {
        appCid,
        convType: 1,
        uuid,
        receiverAppUids: uids,
        contentInfo: {
          contentType: 1,
          content: text,
        },
        convCreateIsSelfVisible: true,
        convRedPointIsNotSelfClear: true,
        extension: {
          additionInfo: JSON.stringify({
            uuid: crypto.randomUUID(),
            sendMsgDoubleCheck: false,
          }),
        },
        callbackCtx: {},
      },
    };
  }

  return {
    payload,
    payloadStr: JSON.stringify(payload),
    traceId,
    sMid,
    uuid,
    seq: safeSeq,
    shopTitle,
    appCid,
    receiverAppUids: uids,
    sessionContext: sessionContext || null,
  };
}

module.exports = {
  buildTextSendPayloadFromContext,
  makeTraceId,
  makeSMid,
  makeUuid,
};
