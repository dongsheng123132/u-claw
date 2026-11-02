@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title U-Claw - Diagnostic Tool

set "UCLAW_DIR=%~dp0"
set "LOG_FILE=%UCLAW_DIR%diagnostic-log.txt"

echo.
echo   ========================================
echo     U-Claw Diagnostic Tool
echo   ========================================
echo.
echo   Checking system...
echo.

REM Clear old log
echo U-Claw Diagnostic Report > "%LOG_FILE%"
echo Generated: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"
echo. >> "%LOG_FILE%"

REM System info
echo System Info: >> "%LOG_FILE%"
for /f "tokens=2 delims==" %%v in ('wmic os get Version /format:list 2^>nul ^| findstr "="') do echo   Windows Version: %%v >> "%LOG_FILE%"
for /f "tokens=2 delims==" %%v in ('wmic os get OSArchitecture /format:list 2^>nul ^| findstr "="') do echo   Architecture: %%v >> "%LOG_FILE%"
echo. >> "%LOG_FILE%"

REM 1. Check Node.js
echo [1/7] Checking Node.js runtime...
set "NODE_BIN=%UCLAW_DIR%app\runtime\node-win-x64\node.exe"
set "ERROR_COUNT=0"
if exist "%NODE_BIN%" (
    echo   [OK] Node.js found >> "%LOG_FILE%"
    for /f "tokens=*" %%v in ('"%NODE_BIN%" --version 2^>^&1') do (
        echo       Version: %%v >> "%LOG_FILE%"
        echo   [OK] Node.js runtime: %%v
    )
) else (
    echo   [ERROR] Node.js not found >> "%LOG_FILE%"
    echo   [FAIL] Node.js runtime: missing
    echo       Path: %NODE_BIN% >> "%LOG_FILE%"
    set /a ERROR_COUNT+=1
)

REM Migration shim: rename old core-win to core for existing USB users
if exist "%UCLAW_DIR%app\core-win" if not exist "%UCLAW_DIR%app\core" ren "%UCLAW_DIR%app\core-win" core

REM 2. Check core directory
echo [2/7] Checking dependency directory...
set "CORE_DIR=%UCLAW_DIR%app\core"
if exist "%CORE_DIR%" (
    echo   [OK] core directory exists >> "%LOG_FILE%"
    echo   [OK] Dependency directory: OK
) else (
    echo   [ERROR] core directory not found >> "%LOG_FILE%"
    echo   [FAIL] Dependency directory: missing
    set /a ERROR_COUNT+=1
)

REM 3. Check node_modules
echo [3/7] Checking npm packages...
if exist "%CORE_DIR%\node_modules" (
    echo   [OK] node_modules exists >> "%LOG_FILE%"
    echo   [OK] npm packages: installed
) else (
    echo   [ERROR] node_modules not found >> "%LOG_FILE%"
    echo   [FAIL] npm packages: not installed
    set /a ERROR_COUNT+=1
)

REM 4. Check OpenClaw
echo [4/7] Checking OpenClaw core files...
set "OPENCLAW_MJS=%CORE_DIR%\node_modules\openclaw\openclaw.mjs"
if exist "%OPENCLAW_MJS%" (
    echo   [OK] openclaw.mjs found >> "%LOG_FILE%"
    echo   [OK] OpenClaw core: OK
) else (
    echo   [ERROR] openclaw.mjs not found >> "%LOG_FILE%"
    echo   [FAIL] OpenClaw core: missing
    echo       Path: %OPENCLAW_MJS% >> "%LOG_FILE%"
    set /a ERROR_COUNT+=1
)

REM 5. Check config
echo [5/7] Checking config file...
set "STATE_DIR=%UCLAW_DIR%data\.openclaw"
if exist "%STATE_DIR%\openclaw.json" (
    echo   [OK] Config file exists >> "%LOG_FILE%"
    echo   [OK] Config file: OK
    REM Check if model is configured
    findstr /c:"model" "%STATE_DIR%\openclaw.json" >nul 2>&1
    if !errorlevel!==0 (
        echo   [OK] AI model: configured
    ) else (
        echo   [WARN] AI model: not configured - configure it before first use
    )
) else (
    echo   [WARNING] Config not found >> "%LOG_FILE%"
    echo   [WARN] Config file: not created - it is created automatically on first start
)

REM 6. Check port availability
echo [6/7] Checking port usage...
set "PORT_ISSUE=0"
for /l %%p in (18789,1,18799) do (
    netstat -an | findstr ":%%p " | findstr "LISTENING" >nul 2>&1
    if !errorlevel!==0 (
        echo   [WARNING] Port %%p is in use >> "%LOG_FILE%"
        echo   [WARN] Port %%p: already in use
        for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%p " ^| findstr "LISTENING"') do (
            echo       PID: %%a >> "%LOG_FILE%"
        )
        set "PORT_ISSUE=1"
    )
)
if "!PORT_ISSUE!"=="0" (
    echo   [OK] Ports 18789-18799 available >> "%LOG_FILE%"
    echo   [OK] Ports 18789-18799: all available
)

REM 7. Test OpenClaw startup
echo [7/7] Testing OpenClaw startup...
echo. >> "%LOG_FILE%"
echo Testing OpenClaw startup: >> "%LOG_FILE%"
echo ---------------------------------------- >> "%LOG_FILE%"

set "OPENCLAW_HOME=%UCLAW_DIR%data"
set "OPENCLAW_STATE_DIR=%UCLAW_DIR%data\.openclaw"
set "OPENCLAW_CONFIG_PATH=%OPENCLAW_STATE_DIR%\openclaw.json"

if exist "%NODE_BIN%" if exist "%OPENCLAW_MJS%" (
    cd /d "%CORE_DIR%"
    for /f "tokens=*" %%v in ('"%NODE_BIN%" "%OPENCLAW_MJS%" --version 2^>^&1') do (
        echo   %%v >> "%LOG_FILE%"
        echo   [OK] OpenClaw startup test: passed (%%v^)
    )
    if !errorlevel! neq 0 (
        echo   [FAIL] OpenClaw startup test: failed
        echo   [ERROR] OpenClaw failed to start >> "%LOG_FILE%"
        set /a ERROR_COUNT+=1
    )
) else (
    echo   [WARN] OpenClaw startup test: skipped - files missing
    echo   [SKIP] Cannot test - required files missing >> "%LOG_FILE%"
)

REM Disk space check
echo. >> "%LOG_FILE%"
echo Disk Space: >> "%LOG_FILE%"
for /f "tokens=*" %%s in ('powershell -command "(Get-ChildItem '%UCLAW_DIR%' -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB" 2^>nul') do (
    echo   Total size: %%s MB >> "%LOG_FILE%"
)

echo.
echo. >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"
echo Diagnostic complete. >> "%LOG_FILE%"
echo Error count: !ERROR_COUNT! >> "%LOG_FILE%"

echo   ========================================
echo     Diagnostics complete
echo   ========================================
echo.

if !ERROR_COUNT!==0 (
    echo   [OK] Result: all checks passed!
    echo   All required components are ready.
    echo.
    echo   Next steps:
    echo   - Double-click Windows-Start.bat to start the service
    echo   - Or double-click Config.html to configure the AI model
) else (
    echo   [FAIL] Result: problems found: !ERROR_COUNT!
    echo.
    echo   How to fix:
    echo   1. Open diagnostic-log.txt for details
    echo   2. Try running Windows-Start.bat again
    echo      - it installs missing dependencies automatically
    echo   3. If the problem persists, visit:
    echo      github.com/dongsheng123132/u-claw
)
echo.
echo   Diagnostic log saved to: diagnostic-log.txt
echo.
pause
