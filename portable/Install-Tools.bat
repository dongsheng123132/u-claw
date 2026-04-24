@echo off
chcp 65001 >nul 2>&1
title U-Claw - Install CLI Tools
echo ========================================
echo   Install CLI Tools for OpenClaw Skills
echo ========================================
echo.

echo [1/5] Installing GitHub CLI (gh)...
winget install GitHub.cli --silent --accept-package-agreements --accept-source-agreements 2>nul
if %errorlevel%==0 (echo   OK: gh installed) else (echo   SKIP: gh already installed or winget unavailable)

echo.
echo [2/5] Installing jq...
winget install jqlang.jq --silent --accept-package-agreements --accept-source-agreements 2>nul
if %errorlevel%==0 (echo   OK: jq installed) else (echo   SKIP: jq already installed or winget unavailable)

echo.
echo [3/5] Installing codexbar...
npm install -g codexbar 2>nul
if %errorlevel%==0 (echo   OK: codexbar installed) else (echo   SKIP: codexbar already installed)

echo.
echo [4/5] Installing xurl...
npm install -g xurl 2>nul
if %errorlevel%==0 (echo   OK: xurl installed) else (echo   SKIP: xurl already installed)

echo.
echo [5/5] Installing nano-pdf...
npm install -g nano-pdf 2>nul
if %errorlevel%==0 (echo   OK: nano-pdf installed) else (echo   SKIP: nano-pdf already installed)

echo.
echo ========================================
echo   Done
echo ========================================
echo.
echo Note: Some tools (gh, jq) require winget.
echo If winget is missing, install it from Microsoft Store.
echo.
pause
