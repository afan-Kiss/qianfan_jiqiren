# 部署千帆协议守护 + 祥钰桥接到服务器（需本机可 SSH 到 8.137.126.18）
param(
  [string]$Server = "root@8.137.126.18",
  [string]$RemoteDir = "/opt/qianfan-protocol"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

Write-Host "[deploy] 同步项目 → ${Server}:${RemoteDir}"
ssh $Server "mkdir -p ${RemoteDir}/config ${RemoteDir}/data"
scp -r "$RepoRoot\src" "$RepoRoot\scripts" "$RepoRoot\config" "$RepoRoot\ecosystem.config.cjs" "$RepoRoot\package.json" "${Server}:${RemoteDir}/"
scp "$RepoRoot\config\qianfan-protocol-shops.local.json" "${Server}:${RemoteDir}/config/" 2>$null
scp "$RepoRoot\data\app-cid-receivers.json" "${Server}:${RemoteDir}/data/" 2>$null
scp "$RepoRoot\data\qianfan-session-context.json" "${Server}:${RemoteDir}/data/" 2>$null
scp "$RepoRoot\test-assets\qianfan-test-image.jpg" "${Server}:${RemoteDir}/test-assets/" 2>$null

ssh $Server @"
set -e
cd ${RemoteDir}
npm install --omit=dev
export QIANFAN_PROTOCOL_BRIDGE_PRODUCTION=1
pm2 delete qianfan-protocol-daemon qianfan-protocol-bridge 2>/dev/null || true
pm2 start ecosystem.config.cjs --only qianfan-protocol-daemon,qianfan-protocol-bridge
pm2 save
curl -s http://127.0.0.1:35872/health || true
"@

Write-Host "[deploy] 完成。祥钰 bridge.url = http://8.137.126.18:35872/send"
Write-Host "[deploy] 祥钰 Web 需另部署: apps/xiangyu 使用 config.server.json"
