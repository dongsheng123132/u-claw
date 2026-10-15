@echo off
chcp 65001 >nul 2>&1
title U-Claw - Install to Windows
REM Runtime pin stays in sync with setup; the shared installer runs setup.bat.
set "NODE_VER=v24.16.0"
REM Windows-Start.bat provides OPENCLAW_DISABLE_BONJOUR=1 after installation.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lib\install-portable.ps1" -SourceRoot "%~dp0."
if errorlevel 1 (
    echo Installation failed. Existing user data was preserved.
    pause
    exit /b 1
)
pause
