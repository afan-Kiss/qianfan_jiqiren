@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion

set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%"

set "WXBOT_EXE=%PROJECT_ROOT%\tools\wxbot-new-runtime\wxbot.exe"
set "WXBOT_DIR=%PROJECT_ROOT%\tools\wxbot-new-runtime"

if not exist "%WXBOT_EXE%" (
    echo [错误] 未找到 wxbot.exe
    pause
    exit /b 1
)

echo [提示] 正在关闭旧微信并启动 wxbot.exe ...
taskkill /F /IM Weixin.exe >nul 2>&1
taskkill /F /IM WeChat.exe >nul 2>&1
start "wxbot-new" /D "%WXBOT_DIR%" "%WXBOT_EXE%"
echo [微信] wxbot.exe 已启动，请扫码登录

:check_loop
call npm run wx:check
if !errorlevel! equ 0 goto check_ok
timeout /t 2 >nul
goto check_loop

:check_ok
echo [微信] 注入检测通过
pause
exit /b 0
