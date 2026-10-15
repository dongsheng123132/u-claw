@echo off
setlocal
chcp 65001 >nul 2>&1
title U-Claw Portable Setup
REM Node pin mirrors setup.ps1; installation behavior lives there.
set "NODE_VERSION=v24.16.0"
if "%~1"=="--all-platforms" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -AllPlatforms
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
)
set "SETUP_EXIT=%ERRORLEVEL%"
if not "%SETUP_EXIT%"=="0" echo [ERROR] Setup failed. Please check the message above.
exit /b %SETUP_EXIT%
