@echo off
chcp 65001 >nul 2>&1
title U-Claw Interactive CLI

set "UCLAW_DIR=%~dp0"
set "APP_DIR=%UCLAW_DIR%app"
set "CORE_DIR=%APP_DIR%\core"
set "DATA_DIR=%UCLAW_DIR%data"
set "NODE_BIN=%APP_DIR%\runtime\node-win-x64\node.exe"
set "OPENCLAW_HOME=%DATA_DIR%"
set "OPENCLAW_STATE_DIR=%DATA_DIR%\.openclaw"
set "OPENCLAW_CONFIG_PATH=%DATA_DIR%\.openclaw\openclaw.json"
set "PATH=%APP_DIR%\runtime\node-win-x64;%PATH%"

if not exist "%NODE_BIN%" (
    echo [ERROR] Node.js runtime not found
    echo Please run Windows-Start.bat first
    pause
    exit /b 1
)

echo.
echo ========================================
echo   U-Claw Interactive CLI
echo ========================================
echo.
echo OpenClaw is now available as 'openclaw' command
echo.
echo Examples:
echo   openclaw --help
echo   openclaw ask "Hello"
echo   openclaw --skill word-writer "Write a report"
echo   openclaw dashboard
echo   openclaw configure
echo.
echo ========================================
echo.

cmd /k "set PATH=%PATH% && set OPENCLAW_HOME=%OPENCLAW_HOME% && set OPENCLAW_CONFIG_PATH=%OPENCLAW_CONFIG_PATH% && set OPENCLAW_STATE_DIR=%OPENCLAW_STATE_DIR% && %NODE_BIN% %CORE_DIR%\node_modules\openclaw\openclaw.mjs --help"
