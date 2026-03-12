@echo off
chcp 65001 >nul 2>&1
title U-Claw - Portable AI Agent

echo.
echo   ========================================
echo     U-Claw v1.1 - Portable AI Agent
echo   ========================================
echo.

set "UCLAW_DIR=%~dp0"
set "APP_DIR=%UCLAW_DIR%app"
set "CORE_DIR=%APP_DIR%\core-win"
set "DATA_DIR=%UCLAW_DIR%data"
set "STATE_DIR=%DATA_DIR%\.openclaw"
set "NODE_DIR=%APP_DIR%\runtime\node-win-x64"
set "NODE_BIN=%NODE_DIR%\node.exe"
set "NPM_BIN=%NODE_DIR%\npm.cmd"

set "OPENCLAW_HOME=%DATA_DIR%"
set "OPENCLAW_STATE_DIR=%STATE_DIR%"
set "OPENCLAW_CONFIG_PATH=%STATE_DIR%\openclaw.json"

REM Check runtime
if not exist "%NODE_BIN%" (
    echo   [ERROR] Node.js runtime not found
    echo   Please ensure app\runtime\node-win-x64 is complete
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('"%NODE_BIN%" --version') do set NODE_VER=%%v
echo   Node.js: %NODE_VER%
echo.

set "PATH=%NODE_DIR%;%NODE_DIR%\node_modules\.bin;%PATH%"

REM Init data
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
if not exist "%STATE_DIR%" mkdir "%STATE_DIR%"
if not exist "%DATA_DIR%\memory" mkdir "%DATA_DIR%\memory"
if not exist "%DATA_DIR%\backups" mkdir "%DATA_DIR%\backups"

REM Default config
if not exist "%STATE_DIR%\openclaw.json" (
    echo   First run - creating default config...
    echo {"gateway":{"mode":"local","auth":{"token":"uclaw"}}} > "%STATE_DIR%\openclaw.json"
    echo   Config created
    echo.
)

REM Check dependencies
if not exist "%CORE_DIR%\node_modules" (
    echo   First run - installing dependencies...
    echo   Using China mirror, please wait...
    echo.
    cd /d "%CORE_DIR%"
    call "%NPM_BIN%" install --registry=https://registry.npmmirror.com
    echo.
    echo   Dependencies installed!
    echo.
)

REM OpenClaw doesn't need a separate build step when installed via npm

REM Find available port
set PORT=18789
:check_port
netstat -an | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo   Port %PORT% in use, trying next...
    set /a PORT+=1
    if %PORT% gtr 18799 (
        echo   No available port 18789-18799
        pause
        exit /b 1
    )
    goto :check_port
)

echo   Starting OpenClaw on port %PORT%...
echo   DO NOT close this window!
echo.

cd /d "%CORE_DIR%"

REM Always open dashboard - it will guide first-time setup
echo   正在打开控制台...
echo   Opening dashboard at http://127.0.0.1:%PORT%
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:%PORT%/#token=uclaw

set "OPENCLAW_MJS=%CORE_DIR%\node_modules\openclaw\openclaw.mjs"
"%NODE_BIN%" "%OPENCLAW_MJS%" gateway run --allow-unconfigured --force --port %PORT%

echo.
echo   OpenClaw stopped.
pause
