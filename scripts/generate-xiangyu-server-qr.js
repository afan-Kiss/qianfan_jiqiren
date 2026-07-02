#!/usr/bin/env node
/**
 * 生成祥钰服务器入口二维码（打包拍照页）
 */
const fs = require('fs');
const path = require('path');
const { resolveProjectRoot } = require('../src/shared/app-root');

const SERVER_HOST = String(process.env.XIANGYU_SERVER_HOST || '8.137.126.18').trim();
const SERVER_SCHEME = String(process.env.XIANGYU_SERVER_SCHEME || 'https').replace(/:$/, '');
const SERVER_PATH = String(process.env.XIANGYU_SERVER_PATH || '/xiangyuxitong').replace(/\/$/, '');
const OUT_DIR = path.join(resolveProjectRoot(), 'tmp', 'xiangyu-server-qr');
const OUT_PNG = path.join(OUT_DIR, 'xiangyu-server-access.png');
const OUT_URL = path.join(OUT_DIR, 'xiangyu-server-url.txt');

async function main() {
  const pageUrl = `${SERVER_SCHEME}://${SERVER_HOST}${SERVER_PATH}/`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_URL, `${pageUrl}\n`, 'utf8');

  let QRCode;
  try {
    QRCode = require('qrcode');
  } catch {
    console.error('[qr] 请先安装: npm install qrcode');
    console.log(`[qr] 祥钰入口 URL: ${pageUrl}`);
    process.exit(1);
  }

  await QRCode.toFile(OUT_PNG, pageUrl, { width: 360, margin: 2, errorCorrectionLevel: 'M' });
  const dataUrl = await QRCode.toDataURL(pageUrl, { width: 220, margin: 1 });

  console.log('[qr] 祥钰服务器入口');
  console.log(`  URL: ${pageUrl}`);
  console.log(`  PNG: ${OUT_PNG}`);
  console.log(`  说明: 手机浏览器扫码打开祥钰打包拍照（需服务器已部署祥钰 Web）`);
  console.log(`  data:image 前缀长度: ${dataUrl.length}`);
}

main().catch((err) => {
  console.error('[qr] 失败:', err.message || err);
  process.exit(1);
});
