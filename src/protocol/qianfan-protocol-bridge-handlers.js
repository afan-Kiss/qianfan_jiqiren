/**
 * 千帆纯协议桥接 — 祥钰 bridge-relay 兼容 HTTP 处理
 */
const { getProtocolImService } = require('./qianfan-protocol-service');
const { probeShopConfig } = require('./qianfan-protocol-config');
const { applyAnalystCookieToShopConfig } = require('./qianfan-protocol-analyst-cookie');

function buildTextReceipt(result, session) {
  const msgId = result?.ack?.msgId || result?.sendResult?.ack?.msgId || '';
  const delivered = Boolean(msgId || result?.ok);
  return {
    ok: delivered,
    delivered,
    ackOk: delivered,
    msgId,
    traceId: result?.traceId || result?.built?.traceId || result?.sendResult?.traceId || '',
    ackSource: 'protocol_ws',
    shopTitle: session?.shopTitle || '',
    buyerNick: session?.buyerNick || '',
    appCid: session?.appCid || result?.appCid || '',
    mediaType: 'text',
    message: delivered ? '发送成功，协议已确认' : result?.error || '发送未确认',
    bridgeMode: 'protocol',
  };
}

function buildImageReceipt(result, session, extra = {}) {
  const msgId = result?.msgId || result?.sendResult?.ack?.msgId || '';
  const delivered = Boolean(msgId || result?.ok);
  return {
    ok: delivered,
    delivered,
    ackOk: delivered,
    msgId,
    traceId: result?.traceId || result?.built?.traceId || '',
    ackSource: 'protocol_ws',
    shopTitle: session?.shopTitle || '',
    buyerNick: session?.buyerNick || '',
    appCid: session?.appCid || result?.appCid || '',
    mediaType: 'image',
    message: delivered ? '发送成功，协议已确认' : result?.error || '发送未确认',
    bridgeMode: 'protocol',
    ...extra,
  };
}

async function getShopService(shopTitle) {
  const title = String(shopTitle || '祥钰珠宝').trim() || '祥钰珠宝';
  const svc = await getProtocolImService(title, { noCache: false });
  if (svc?.config) {
    svc.config = await applyAnalystCookieToShopConfig(svc.config);
    if (svc.client?.shopConfig) {
      svc.client.shopConfig = svc.config;
    }
  }
  return svc;
}

async function handleBridgeHealth(shopTitle = '祥钰珠宝') {
  try {
    const svc = await getShopService(shopTitle);
    const probe = probeShopConfig(svc.config);
    const ready = Boolean(
      probe?.hasWsUrl &&
        probe?.hasImageSendPayloadSample &&
        probe?.hasTestAppCid &&
        probe?.hasReceiverAppUids
    );
    return {
      ok: ready,
      service: 'qianfan-protocol-bridge',
      protocolReady: ready,
      shopTitle,
      message: ready ? '可以正常发消息（纯协议）' : '协议凭证或 WS 样本未就绪',
      probe,
    };
  } catch (err) {
    return {
      ok: false,
      service: 'qianfan-protocol-bridge',
      message: err.message || String(err),
    };
  }
}

async function handleBridgeOpenSession(body) {
  const shopTitle = body?.shopTitle || '祥钰珠宝';
  const svc = await getShopService(shopTitle);
  return svc.openSession(body || {});
}

async function handleBridgeSend(body) {
  const type = String(body?.type || 'send_image').trim();
  const shopTitle = body?.shopTitle || '祥钰珠宝';
  const svc = await getShopService(shopTitle);

  if (type === 'send_text') {
    const result = await svc.sendTextForBridge({
      shopTitle,
      appCid: body.appCid,
      receiverAppUids: body.receiverAppUids,
      buyerNick: body.buyerNick,
      buyerUserId: body.buyerUserId,
      text: body.text,
      reallySend: true,
    });
    return buildTextReceipt(result, result.session);
  }

  if (type === 'send_image') {
    let preface = null;
    const prefaceText = String(body.prefaceText || '').trim();
    if (body.sendPreface && prefaceText) {
      preface = await svc.sendTextForBridge({
        shopTitle,
        appCid: body.appCid,
        receiverAppUids: body.receiverAppUids,
        buyerNick: body.buyerNick,
        buyerUserId: body.buyerUserId,
        text: prefaceText,
        reallySend: true,
      });
      await new Promise((r) => setTimeout(r, 400));
    }

    try {
      const result = await svc.sendImageForBridge({
        shopTitle,
        appCid: body.appCid,
        receiverAppUids: body.receiverAppUids,
        buyerNick: body.buyerNick,
        buyerUserId: body.buyerUserId,
        imageBase64: body.imageBase64,
        imagePath: body.imagePath,
        width: body.width,
        height: body.height,
        reallySend: true,
      });
      const receipt = buildImageReceipt(result, {
        shopTitle,
        buyerNick: body.buyerNick,
        appCid: result.appCid,
      }, {
        fileId: result.uploadResult?.fileId || '',
        preface: preface ? buildTextReceipt(preface, preface.session) : null,
      });
      return receipt;
    } catch (err) {
      if (preface?.ok) {
        throw new Error(`说明文字已发出，但图片发送失败：${err.message || err}`);
      }
      throw err;
    }
  }

  throw new Error(`不支持的 type: ${type}`);
}

module.exports = {
  handleBridgeHealth,
  handleBridgeOpenSession,
  handleBridgeSend,
};
