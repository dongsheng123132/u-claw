@echo off
chcp 65001 >nul 2>&1
title U-Claw - Intranet Check
setlocal

set "UCLAW_DIR=%~dp0"
set "NODE_BIN=%UCLAW_DIR%app\runtime\node-win-x64\node.exe"
set "CONFIG_PATH=%UCLAW_DIR%data\.openclaw\openclaw.json"

if not exist "%NODE_BIN%" (
    echo   [ERROR] Node runtime not found.
    echo   Put this file inside your U-Claw folder, next to Windows-Start.bat, then run again.
    echo.
    pause
    exit /b 1
)

REM Local cache/temp/log dirs via the shared resolver. This is a checkup tool:
REM report a cache problem but keep going with the basic network checks.
call "%UCLAW_DIR%lib\portable-cache-env.bat" "%UCLAW_DIR%data\.openclaw" "%UCLAW_DIR%"
if errorlevel 1 (
    echo   [WARNING] No writable local cache directory. Continuing the check.
)

"%NODE_BIN%" "%UCLAW_DIR%lib\intranet-check.mjs" "%CONFIG_PATH%"

echo.
echo   Please screenshot the whole window and send it to support.
echo.
pause
