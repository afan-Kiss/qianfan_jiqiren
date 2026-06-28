@echo off
setlocal EnableExtensions

set "PROJECT_ROOT=%~dp0"
cd /d "%PROJECT_ROOT%"

where node >nul 2>&1
if errorlevel 1 goto no_node

where npm >nul 2>&1
if errorlevel 1 goto no_npm

if not exist "%PROJECT_ROOT%node_modules" goto install_deps
goto run_app

:install_deps
echo [INFO] First run, running npm install ...
call npm install
if errorlevel 1 goto install_failed

:run_app
echo.
echo ========================================
echo   Dev mode: npm start
echo   Then click Start Relay in the app UI
echo ========================================
echo.
call npm start
if errorlevel 1 goto start_failed
goto end_ok

:no_node
echo [ERROR] Node.js not found. Please install Node 18 or later.
pause
exit /b 1

:no_npm
echo [ERROR] npm not found. Please reinstall Node.js.
pause
exit /b 1

:install_failed
echo [ERROR] npm install failed.
pause
exit /b 1

:start_failed
echo [ERROR] npm start failed.
pause
exit /b 1

:end_ok
endlocal
exit /b 0
