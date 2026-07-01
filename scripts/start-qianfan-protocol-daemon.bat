@echo off
setlocal
cd /d "%~dp0.."
echo [qf] 启动千帆纯协议守护进程...
npm run qf:protocol:daemon
endlocal
