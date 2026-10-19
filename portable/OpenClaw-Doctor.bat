@echo off
chcp 65001 >nul 2>&1
title U-Claw - OpenClaw Doctor (advanced)
setlocal

REM Official OpenClaw health check (English, advanced users).
REM NOTE: run this AFTER U-Claw is already running (double-click Windows-Start.bat
REM first), otherwise doctor stalls while probing a gateway that is not up yet.
REM Read-only: we deliberately do NOT pass --fix/--repair/--force.

set "UCLAW_DIR=%~dp0"
set "APP_DIR=%UCLAW_DIR%app"
set "CORE_DIR=%APP_DIR%\core"
set "DATA_DIR=%UCLAW_DIR%data"
set "STATE_DIR=%DATA_DIR%\.openclaw"
set "NODE_BIN=%APP_DIR%\runtime\node-win-x64\node.exe"
set "OPENCLAW_MJS=%CORE_DIR%\node_modules\openclaw\openclaw.mjs"

set "OPENCLAW_HOME=%DATA_DIR%"
set "OPENCLAW_STATE_DIR=%STATE_DIR%"
set "OPENCLAW_CONFIG_PATH=%STATE_DIR%\openclaw.json"
set "OPENCLAW_DISABLE_BONJOUR=1"

if not exist "%NODE_BIN%" (
    echo   [ERROR] Node runtime not found. Put this file inside your U-Claw folder.
    echo.
    pause
    exit /b 1
)
if not exist "%OPENCLAW_MJS%" (
    echo   [ERROR] OpenClaw runtime not found ^(app\core\node_modules\openclaw^).
    echo.
    pause
    exit /b 1
)

REM Local cache/temp/log dirs via the shared resolver; no local cache = stop.
call "%UCLAW_DIR%lib\portable-cache-env.bat" "%STATE_DIR%" "%UCLAW_DIR%"
if errorlevel 1 (
    echo   [ERROR] No writable local cache directory on this PC.
    pause
    exit /b 1
)

echo.
echo   ========================================
echo     OpenClaw Doctor (official, English)
echo   ========================================
echo   This is the upstream deep health check. It can take a while and is in
echo   English. Make sure U-Claw is ALREADY running first.
echo   If it seems stuck, press Ctrl+C to stop - it is safe (read-only).
echo.
pause

"%NODE_BIN%" "%OPENCLAW_MJS%" doctor --non-interactive

echo.
echo   ----------------------------------------
echo   Doctor finished. For a quick Chinese check of your model connection,
echo   use Windows-IntranetFix.bat instead.
echo.
pause
