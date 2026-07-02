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

function buildPlainTextContentInfo(text) {
  return {
    contentType: 1,
    content: String(text || ''),
  };
}

function buildSafeExtension() {
  return {
    additionInfo: JSON.stringify({
      uuid: crypto.randomUUID(),
      sendMsgDoubleCheck: false,
    }),
  };
}

function isUsableTextManualTemplate(manualTemplate, appCid) {
  const body = manualTemplate?.payload?.body;
  if (!body) return false;
  const templateAppCid = String(body.appCid || manualTemplate.appCid || '').trim();
  const targetAppCid = String(appCid || '').trim();
  if (templateAppCid && targetAppCid && templateAppCid !== targetAppCid) return false;
  const contentType = Number(body.contentInfo?.contentType ?? 1);
  return contentType === 1;
}

function isValidAppCid(appCid) {
  const cid = String(appCid || '').trim();
  if (!cid || cid.length < 16) return false;
  if (cid.startsWith('.')) return false;
  return cid.startsWith('$') || cid.includes('MSMyIz');
}

function buildSendHeader({ traceId, sMid, seq, manualHeader }) {
  const hdr = manualHeader && typeof manualHeader === 'object' ? manualHeader : {};
  return {
    sTime: Date.now(),
    seq,
    type: 3,
    bizId: Number(hdr.bizId) > 0 ? Number(hdr.bizId) : 10,
    contentType: 'json',
    traceId,
    action: '/message/send',
    serviceId: 'impaas.oi',
    oneWay: false,
    sMid,
  };
}

function refreshAdditionInfoUuid(extension) {
  if (!extension?.additionInfo) return buildSafeExtension();
  try {
    const ext = { ...extension };
    const info = JSON.parse(ext.additionInfo);
    info.uuid = crypto.randomUUID();
    ext.additionInfo = JSON.stringify(info);
    return ext;
  } catch {
    return buildSafeExtension();
  }
}

function buildTextSendPayloadFromContext({ shopTitle, appCid, receiverAppUids, text, seq, sessionContext, manualTemplate }) {
  const traceId = makeTraceId();
  const sMid = makeSMid();
  const uuid = makeUuid();
  const safeSeq = Number(seq) > 0 ? Number(seq) : 1;
  const uids = Array.isArray(receiverAppUids) ? receiverAppUids.filter(Boolean) : [];
  const useManual = isUsableTextManualTemplate(manualTemplate, appCid);

  let payload;

  if (useManual && manualTemplate?.payload) {
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
      content: String(text || ''),
    };
    payload.body.extension = refreshAdditionInfoUuid(payload.body.extension);
    if (!payload.body.callbackCtx) payload.body.callbackCtx = {};
  } else {
    payload = {
      header: buildSendHeader({ traceId, sMid, seq: safeSeq, manualHeader: null }),
      body: {
        appCid,
        convType: 1,
        uuid,
        receiverAppUids: uids,
        contentInfo: buildPlainTextContentInfo(text),
        convCreateIsSelfVisible: true,
        convRedPointIsNotSelfClear: true,
        extension: buildSafeExtension(),
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
    manualTemplateUsed: useManual,
  };
}

module.exports = {
  buildTextSendPayloadFromContext,
  isUsableTextManualTemplate,
  isValidAppCid,
  makeTraceId,
  makeSMid,
  makeUuid,
};
