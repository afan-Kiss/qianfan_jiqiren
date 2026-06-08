@echo off
chcp 65001 >nul
title 千帆客服台机器人 - 微信回调服务
cd /d "%~dp0.."
call npm run wx:callback
pause
