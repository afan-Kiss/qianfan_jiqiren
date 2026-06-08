@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0.."
call npm run wx:check
if not !errorlevel! equ 0 (
    echo 请先运行 scripts\01-启动微信注入.bat 或 一键启动微信机器人.bat
    pause
    exit /b 1
)
call npm run wx:test-send
pause
