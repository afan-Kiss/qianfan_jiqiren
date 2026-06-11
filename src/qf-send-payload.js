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

function buildTextSendPayloadFromContext({ shopTitle, appCid, receiverAppUids, text, seq, sessionContext, manualTemplate }) {
  const traceId = makeTraceId();
  const sMid = makeSMid();
  const uuid = makeUuid();
  const safeSeq = Number(seq) > 0 ? Number(seq) : 1;
  const uids = Array.isArray(receiverAppUids) ? receiverAppUids.filter(Boolean) : [];
  const useManual = isUsableTextManualTemplate(manualTemplate, appCid);
  const manualBody = useManual ? manualTemplate.payload.body : null;

  const body = {
    appCid,
    convType: Number(manualBody?.convType) > 0 ? Number(manualBody.convType) : 1,
    uuid,
    receiverAppUids: uids,
    contentInfo: buildPlainTextContentInfo(text),
    convCreateIsSelfVisible: manualBody?.convCreateIsSelfVisible !== false,
    convRedPointIsNotSelfClear: manualBody?.convRedPointIsNotSelfClear !== false,
    extension: buildSafeExtension(),
    callbackCtx: {},
  };

  const payload = {
    header: buildSendHeader({
      traceId,
      sMid,
      seq: safeSeq,
      manualHeader: useManual ? manualTemplate.payload.header : null,
    }),
    body,
  };

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
