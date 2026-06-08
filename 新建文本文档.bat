@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

cd /d "%~dp0"

set REPO=git@gitee.com:ff472336362/qianfanzhongzhuanjiqiren.git
set TARGET_BRANCH=master

echo ==============================
echo 正在上传代码到 Gitee
echo 当前目录：%cd%
echo 仓库地址：%REPO%
echo 目标分支：%TARGET_BRANCH%
echo ==============================

echo.
echo [1/8] 检查 Git...
git --version
if errorlevel 1 (
    echo Git 未安装或未加入环境变量
    pause
    exit /b 1
)

echo.
echo [2/8] 检查当前 Git 仓库是否有效...
git rev-parse --is-inside-work-tree >nul 2>nul

if errorlevel 1 (
    echo 当前 .git 无效或不存在，准备重新初始化 Git 仓库...

    if exist ".git" (
        for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set NOW=%%i
        echo 发现损坏的 .git，备份为 .git_bak_!NOW!
        rename ".git" ".git_bak_!NOW!"
    )

    git init
    if errorlevel 1 (
        echo git init 失败
        pause
        exit /b 1
    )
) else (
    echo 当前 Git 仓库有效
)

echo.
echo [3/8] 设置 Git 基础配置...
git config --global --add safe.directory "%cd%" >nul 2>nul
git config core.quotepath false
git config user.name "ff472336362" >nul 2>nul
git config user.email "17364583794@163.com" >nul 2>nul

echo.
echo [4/8] 切换/创建本地分支 %TARGET_BRANCH%...
git checkout -B %TARGET_BRANCH%

echo.
echo [5/8] 设置 Gitee 远程仓库...
git remote remove origin >nul 2>nul
git remote add origin %REPO%
git remote -v

echo.
echo [6/8] 添加所有文件...
git add -A
if errorlevel 1 (
    echo git add 失败
    pause
    exit /b 1
)

echo.
echo [7/8] 提交代码...
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "update"
    if errorlevel 1 (
        echo commit 失败
        pause
        exit /b 1
    )
) else (
    echo 没有新的文件改动，创建空提交用于上传记录...
    git commit --allow-empty -m "update"
)

echo.
echo [8/8] 强制上传到 Gitee...
git push -u origin %TARGET_BRANCH%:%TARGET_BRANCH% --force

if errorlevel 1 (
    echo.
    echo ==============================
    echo 上传失败
    echo ==============================
    echo 大概率原因：
    echo 1. 你的 Gitee 没配置 SSH 公钥
    echo 2. 这个仓库不存在或你没有权限
    echo 3. SSH 被网络拦截
    echo.
    echo 你可以把失败截图继续发我，我再给你换 HTTPS/token 免手输版本。
    pause
    exit /b 1
)

echo.
echo ==============================
echo 上传成功
echo Gitee 仓库：
echo https://gitee.com/ff472336362/qianfanzhongzhuanjiqiren
echo 分支：%TARGET_BRANCH%
echo ==============================

pause