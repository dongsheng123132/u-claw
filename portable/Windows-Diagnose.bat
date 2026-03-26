@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title M-Claw - Diagnostic Tool

set "UCLAW_DIR=%~dp0"
set "LOG_FILE=%UCLAW_DIR%diagnostic-log.txt"

echo.
echo   ========================================
echo     M-Claw Diagnostic Tool
echo   ========================================
echo.
echo   Checking system...
echo.

REM Clear old log
echo M-Claw Diagnostic Report > "%LOG_FILE%"
echo Generated: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"
echo. >> "%LOG_FILE%"

REM System info
echo System Info: >> "%LOG_FILE%"
for /f "tokens=2 delims==" %%v in ('wmic os get Version /format:list 2^>nul ^| findstr "="') do echo   Windows Version: %%v >> "%LOG_FILE%"
for /f "tokens=2 delims==" %%v in ('wmic os get OSArchitecture /format:list 2^>nul ^| findstr "="') do echo   Architecture: %%v >> "%LOG_FILE%"
echo. >> "%LOG_FILE%"

REM 1. Check Node.js
echo [1/7] 检查 Node.js 运行环境...
set "NODE_BIN=%UCLAW_DIR%app\runtime\node-win-x64\node.exe"
set "ERROR_COUNT=0"
if exist "%NODE_BIN%" (
    echo   [OK] Node.js found >> "%LOG_FILE%"
    for /f "tokens=*" %%v in ('"%NODE_BIN%" --version 2^>^&1') do (
        echo       Version: %%v >> "%LOG_FILE%"
        echo   ✓ Node.js 运行环境: %%v
    )
) else (
    echo   [ERROR] Node.js not found >> "%LOG_FILE%"
    echo   ✗ Node.js 运行环境: 缺失
    echo       Path: %NODE_BIN% >> "%LOG_FILE%"
    set /a ERROR_COUNT+=1
)

REM Migration shim: rename old core-win to core for existing USB users
if exist "%UCLAW_DIR%app\core-win" if not exist "%UCLAW_DIR%app\core" ren "%UCLAW_DIR%app\core-win" core

REM 2. Check core directory
echo [2/7] 检查依赖目录...
set "CORE_DIR=%UCLAW_DIR%app\core"
if exist "%CORE_DIR%" (
    echo   [OK] core directory exists >> "%LOG_FILE%"
    echo   ✓ 依赖目录: 正常
) else (
    echo   [ERROR] core directory not found >> "%LOG_FILE%"
    echo   ✗ 依赖目录: 缺失
    set /a ERROR_COUNT+=1
)

REM 3. Check node_modules
echo [3/7] 检查 npm 依赖包...
if exist "%CORE_DIR%\node_modules" (
    echo   [OK] node_modules exists >> "%LOG_FILE%"
    echo   ✓ npm 依赖包: 已安装
) else (
    echo   [ERROR] node_modules not found >> "%LOG_FILE%"
    echo   ✗ npm 依赖包: 未安装
    set /a ERROR_COUNT+=1
)

REM 4. Check OpenClaw
echo [4/7] 检查 OpenClaw 核心文件...
set "OPENCLAW_MJS=%CORE_DIR%\node_modules\openclaw\openclaw.mjs"
if exist "%OPENCLAW_MJS%" (
    echo   [OK] openclaw.mjs found >> "%LOG_FILE%"
    echo   ✓ OpenClaw 核心: 正常
) else (
    echo   [ERROR] openclaw.mjs not found >> "%LOG_FILE%"
    echo   ✗ OpenClaw 核心: 缺失
    echo       Path: %OPENCLAW_MJS% >> "%LOG_FILE%"
    set /a ERROR_COUNT+=1
)

REM 5. Check config
echo [5/7] 检查配置文件...
set "STATE_DIR=%UCLAW_DIR%data\.openclaw"
if exist "%STATE_DIR%\openclaw.json" (
    echo   [OK] Config file exists >> "%LOG_FILE%"
    echo   ✓ 配置文件: 正常
    REM Check if model is configured
    findstr /c:"model" "%STATE_DIR%\openclaw.json" >nul 2>&1
    if !errorlevel!==0 (
        echo   ✓ AI 模型: 已配置
    ) else (
        echo   ⚠ AI 模型: 未配置（首次使用请先配置）
    )
) else (
    echo   [WARNING] Config not found >> "%LOG_FILE%"
    echo   ⚠ 配置文件: 未创建（首次启动会自动创建）
)

REM 6. Check port availability
echo [6/7] 检查端口占用...
set "PORT_ISSUE=0"
for /l %%p in (18789,1,18799) do (
    netstat -an | findstr ":%%p " | findstr "LISTENING" >nul 2>&1
    if !errorlevel!==0 (
        echo   [WARNING] Port %%p is in use >> "%LOG_FILE%"
        echo   ⚠ 端口 %%p: 已被占用
        for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%p " ^| findstr "LISTENING"') do (
            echo       PID: %%a >> "%LOG_FILE%"
        )
        set "PORT_ISSUE=1"
    )
)
if "!PORT_ISSUE!"=="0" (
    echo   [OK] Ports 18789-18799 available >> "%LOG_FILE%"
    echo   ✓ 端口 18789-18799: 全部可用
)

REM 7. Test OpenClaw startup
echo [7/7] 测试 OpenClaw 启动...
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
        echo   ✓ OpenClaw 启动测试: 通过 (%%v^)
    )
    if !errorlevel! neq 0 (
        echo   ✗ OpenClaw 启动测试: 失败
        echo   [ERROR] OpenClaw failed to start >> "%LOG_FILE%"
        set /a ERROR_COUNT+=1
    )
) else (
    echo   ⚠ OpenClaw 启动测试: 跳过（文件缺失）
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
echo     诊断完成
echo   ========================================
echo.

if !ERROR_COUNT!==0 (
    echo   ✅ 检查结果: 全部正常！
    echo   所有必需的组件都已就绪，可以正常使用。
    echo.
    echo   下一步:
    echo   - 双击 Windows-Start.bat 启动服务
    echo   - 或双击 Config.html 配置 AI 模型
) else (
    echo   ❌ 检查结果: 发现 !ERROR_COUNT! 个问题
    echo.
    echo   解决方案:
    echo   1. 查看 diagnostic-log.txt 了解详细错误
    echo   2. 尝试重新运行 Windows-Start.bat
    echo      （会自动安装缺失的依赖）
    echo   3. 如问题仍然存在，访问:
    echo      github.com/dongsheng123132/u-claw
)
echo.
echo   诊断日志已保存: diagnostic-log.txt
echo.
pause
