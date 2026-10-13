@echo off
setlocal
chcp 65001 >nul 2>&1
REM Kept in sync by tests/node-version-satisfies-openclaw.test.mjs.
set "NODE_VERSION=v24.16.0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
if errorlevel 1 (
    echo Setup failed. See the error above.
    pause
    exit /b 1
)
exit /b 0
