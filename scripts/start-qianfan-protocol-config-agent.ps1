$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
Write-Host "[qf] 启动千帆纯协议配置刷新代理..."
npm run qf:protocol:config-agent
