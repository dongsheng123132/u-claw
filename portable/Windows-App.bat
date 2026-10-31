@echo off
chcp 65001 >nul 2>&1
title U-Claw - App Mode

echo.
echo   ========================================
echo     U-Claw - App Mode
echo   ========================================
echo.

REM Edge app-mode launcher. The untouched Windows-Start.bat still opens the
REM browser dashboard on a normal double-click; this wrapper opens the WebUI in
REM a standalone Edge --app window instead (no tabs / address bar).
REM
REM Headless: Windows-Start.bat must not open its own browser while we wait for
REM the gateway. lib/open-app.ps1 opens the app window once /ready is live.

set "UCLAW_HEADLESS=1"

set "UCLAW_DIR=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%UCLAW_DIR%lib\open-app.ps1" -Mode edge
exit /b %errorlevel%
