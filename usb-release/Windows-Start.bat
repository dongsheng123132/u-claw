@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title M-Claw - Portable AI Agent

echo.
echo   ========================================
echo     M-Claw - Portable AI Agent
echo   ========================================
echo.

set "UCLAW_DIR=%~dp0"
set "CORE_DIR=%UCLAW_DIR%core"
set "DATA_DIR=%UCLAW_DIR%data"
set "STATE_DIR=%DATA_DIR%\.openclaw"
set "NODE_DIR=%UCLAW_DIR%runtime\node-win-x64"
set "NODE_BIN=%NODE_DIR%\node.exe"
set "NPM_BIN=%NODE_DIR%\npm.cmd"

set "OPENCLAW_HOME=%DATA_DIR%"
set "OPENCLAW_STATE_DIR=%STATE_DIR%"
set "OPENCLAW_CONFIG_PATH=%STATE_DIR%\openclaw.json"

REM Check runtime
if not exist "%NODE_BIN%" (
    echo   [ERROR] Node.js runtime not found
    echo   Please ensure runtime\node-win-x64 is complete
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('"%NODE_BIN%" --version') do set NODE_VER=%%v
echo   Node.js: %NODE_VER%
echo.

set "PATH=%NODE_DIR%;%NODE_DIR%\node_modules\.bin;%PATH%"

REM Init data directories
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
if not exist "%STATE_DIR%" mkdir "%STATE_DIR%"
if not exist "%DATA_DIR%\memory" mkdir "%DATA_DIR%\memory"
if not exist "%DATA_DIR%\backups" mkdir "%DATA_DIR%\backups"
if not exist "%DATA_DIR%\logs" mkdir "%DATA_DIR%\logs"

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

REM Find available port
set PORT=18789
:check_port
netstat -an | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if !errorlevel!==0 (
    echo   Port %PORT% in use, trying next...
    set /a PORT+=1
    if !PORT! gtr 18799 (
        echo   No available port 18789-18799
        pause
        exit /b 1
    )
    goto :check_port
)

REM Read token from config
set "TOKEN=uclaw"
if exist "%STATE_DIR%\openclaw.json" (
    for /f "tokens=*" %%t in ('"%NODE_BIN%" -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log((c.gateway&&c.gateway.auth&&c.gateway.auth.token)||'uclaw')}catch(e){console.log('uclaw')}" "%STATE_DIR%\openclaw.json"') do set "TOKEN=%%t"
)

echo   Starting OpenClaw on port !PORT!...
echo   DO NOT close this window while using M-Claw!
echo.

cd /d "%CORE_DIR%"
set "OPENCLAW_MJS=%CORE_DIR%\node_modules\openclaw\openclaw.mjs"
echo   Log: %DATA_DIR%\logs\gateway.log

REM Check if model is configured
set "HAS_MODEL=no"
if exist "%STATE_DIR%\openclaw.json" (
    findstr /c:"model" "%STATE_DIR%\openclaw.json" >nul 2>&1 && set "HAS_MODEL=yes"
)

REM Open browser after a short delay
if "!HAS_MODEL!"=="yes" (
    echo   Opening dashboard in 3 seconds...
    start /B "" cmd /c "timeout /t 3 /nobreak >nul && start http://127.0.0.1:!PORT!/#token=!TOKEN!"
) else (
    echo   First time setup - opening Config page in 3 seconds...
    start /B "" cmd /c "timeout /t 3 /nobreak >nul && start %UCLAW_DIR%Config.html?port=!PORT!"
)

REM Start gateway (foreground, blocks until stopped)
"%NODE_BIN%" "%OPENCLAW_MJS%" gateway run --allow-unconfigured --force --port !PORT! 2>&1 | powershell -command "& { $input | Tee-Object -Append -FilePath '%DATA_DIR%\logs\gateway.log' }"

echo.
echo   OpenClaw stopped.
pause
