@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ==============================
echo 正在上传当前目录到 GitHub
echo 仓库：https://github.com/afan-Kiss/qianfan_jiqiren.git
echo 当前目录：%cd%
echo 代理端口：7890
echo ==============================
echo.

REM 检查 Git
git --version >nul 2>nul
if errorlevel 1 (
    echo [错误] 没检测到 Git，请先安装 Git。
    pause
    exit /b 1
)

REM 设置 Git 代理，优先 http
git config --local http.proxy http://127.0.0.1:7890
git config --local https.proxy http://127.0.0.1:7890

REM 初始化 Git 仓库
if not exist ".git" (
    echo 初始化 Git 仓库...
    git init
)

REM 设置分支为 main
git branch -M main

REM 设置远程仓库
echo 设置远程仓库 origin...
git remote remove origin >nul 2>nul
git remote add origin https://github.com/afan-Kiss/qianfan_jiqiren.git

REM 添加全部文件
echo 添加文件...
git add -A

REM 检查是否有改动
git diff --cached --quiet
if errorlevel 1 (
    echo 提交代码...
    git commit -m "upload"
) else (
    echo 没有检测到新的文件改动，跳过提交。
)

REM 第一次推送：HTTP 代理
echo.
echo 使用 HTTP 代理上传到 GitHub...
git push -u origin main
if %errorlevel%==0 goto success

echo.
echo HTTP 代理上传失败，切换 socks5h 代理重试...
git config --local http.proxy socks5h://127.0.0.1:7890
git config --local https.proxy socks5h://127.0.0.1:7890

git push -u origin main
if %errorlevel%==0 goto success

echo.
echo 常规上传失败，尝试拉取远程仓库后再上传...
git pull origin main --rebase --allow-unrelated-histories
if not %errorlevel%==0 (
    echo.
    echo [错误] 拉取远程仓库失败，可能远程仓库有冲突，需要处理冲突后再上传。
    pause
    exit /b 1
)

git push -u origin main
if %errorlevel%==0 goto success

echo.
echo [错误] 上传失败。
echo 可能原因：
echo 1. GitHub 没登录或没有权限
echo 2. 仓库地址不对
echo 3. 代理 127.0.0.1:7890 不通
echo 4. 远程仓库和本地文件冲突
pause
exit /b 1

:success
echo.
echo ==============================
echo 上传成功
echo 上传时间：%date% %time%
echo 分支名：main
for /f %%i in ('git rev-parse HEAD') do echo Commit Hash：%%i
echo GitHub 仓库：https://github.com/afan-Kiss/qianfan_jiqiren.git
echo ==============================
pause
exit /b 0