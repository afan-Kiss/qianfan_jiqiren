#!/usr/bin/env bash
# 部署千帆协议守护 + 祥钰桥接到 Debian 服务器（需 SSH 免密或手动输入密码）
set -euo pipefail

SERVER="${DEPLOY_SERVER:-root@8.137.126.18}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/opt/qianfan-protocol}"
XIANGYU_DIR="${DEPLOY_XIANGYU_DIR:-/opt/xiangyu}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[deploy] 同步千帆协议项目 → ${SERVER}:${REMOTE_DIR}"
ssh "$SERVER" "mkdir -p ${REMOTE_DIR}/config ${REMOTE_DIR}/data ${REMOTE_DIR}/tmp"
rsync -avz --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude 'config/qianfan-protocol-shops.local.json' \
  "$REPO_ROOT/" "${SERVER}:${REMOTE_DIR}/"

echo "[deploy] 上传 protocol 配置与 data 样本"
scp "$REPO_ROOT/config/qianfan-protocol-shops.local.json" "${SERVER}:${REMOTE_DIR}/config/" 2>/dev/null || true
scp "$REPO_ROOT/dist/win-unpacked/data/app-cid-receivers.json" "${SERVER}:${REMOTE_DIR}/data/" 2>/dev/null || true
scp "$REPO_ROOT/dist/win-unpacked/data/qianfan-session-context.json" "${SERVER}:${REMOTE_DIR}/data/" 2>/dev/null || true

echo "[deploy] 安装依赖并 PM2 启动"
ssh "$SERVER" bash -s <<EOF
set -e
cd ${REMOTE_DIR}
npm install --omit=dev
export QIANFAN_PROTOCOL_BRIDGE_PRODUCTION=1
pm2 delete qianfan-protocol-daemon qianfan-protocol-bridge 2>/dev/null || true
pm2 start ecosystem.config.cjs --only qianfan-protocol-daemon,qianfan-protocol-bridge
pm2 save
curl -s http://127.0.0.1:9324/api/health || true
curl -s http://127.0.0.1:35872/health || true
EOF

echo "[deploy] 完成。祥钰 bridge.url 请设为: http://${SERVER#*@}:35872/send"
echo "[deploy] 祥钰 Web 端口默认 35871，请单独部署扫码枪 xiangyu 应用"
