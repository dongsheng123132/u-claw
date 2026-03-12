@echo off
chcp 65001 >nul 2>&1
title U-Claw - Diagnostic Tool

set "UCLAW_DIR=%~dp0"
set "LOG_FILE=%UCLAW_DIR%diagnostic-log.txt"

echo.
echo   ========================================
echo     U-Claw Diagnostic Tool
echo     诊断工具
echo   ========================================
echo.
echo   Checking system... 正在检查系统...
echo.

REM Clear old log
echo U-Claw Diagnostic Report > "%LOG_FILE%"
echo Generated: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"
echo. >> "%LOG_FILE%"

REM 1. Check Node.js
echo [1/6] 检查 Node.js 运行环境...
set "NODE_BIN=%UCLAW_DIR%app\runtime\node-win-x64\node.exe"
set "ERROR_COUNT=0"
if exist "%NODE_BIN%" (
    echo   [OK] Node.js found >> "%LOG_FILE%"
    for /f "tokens=*" %%v in ('"%NODE_BIN%" --version 2^>^&1') do echo       Version: %%v >> "%LOG_FILE%"
    echo   ✓ Node.js 运行环境: 正常
) else (
    echo   [ERROR] Node.js not found >> "%LOG_FILE%"
    echo   ✗ Node.js 运行环境: 缺失
    echo       Path: %NODE_BIN% >> "%LOG_FILE%"
    set /a ERROR_COUNT+=1
)

REM 2. Check core-win directory
echo [2/6] 检查 Windows 依赖目录...
set "CORE_DIR=%UCLAW_DIR%app\core-win"
if exist "%CORE_DIR%" (
    echo   [OK] core-win directory exists >> "%LOG_FILE%"
    echo   ✓ Windows 依赖目录: 正常
) else (
    echo   [ERROR] core-win directory not found >> "%LOG_FILE%"
    echo   ✗ Windows 依赖目录: 缺失
    set /a ERROR_COUNT+=1
)

REM 3. Check node_modules
echo [3/6] 检查 npm 依赖包...
if exist "%CORE_DIR%\node_modules" (
    echo   [OK] node_modules exists >> "%LOG_FILE%"
    echo   ✓ npm 依赖包: 已安装
) else (
    echo   [ERROR] node_modules not found >> "%LOG_FILE%"
    echo   ✗ npm 依赖包: 未安装
    set /a ERROR_COUNT+=1
)

REM 4. Check OpenClaw
echo [4/6] 检查 OpenClaw 核心文件...
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

REM 5. Check port availability
echo [5/6] 检查端口占用...
netstat -an | findstr ":18789 " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo   [WARNING] Port 18789 is in use >> "%LOG_FILE%"
    echo   ⚠ 端口 18789: 已被占用
    netstat -ano | findstr ":18789 " >> "%LOG_FILE%"
) else (
    echo   [OK] Port 18789 is available >> "%LOG_FILE%"
    echo   ✓ 端口 18789: 可用
)

REM 6. Test OpenClaw startup
echo [6/6] 测试 OpenClaw 启动...
echo. >> "%LOG_FILE%"
echo Testing OpenClaw startup: >> "%LOG_FILE%"
echo ---------------------------------------- >> "%LOG_FILE%"

set "OPENCLAW_HOME=%UCLAW_DIR%data"
set "OPENCLAW_STATE_DIR=%UCLAW_DIR%data\.openclaw"
set "OPENCLAW_CONFIG_PATH=%OPENCLAW_STATE_DIR%\openclaw.json"

if exist "%NODE_BIN%" if exist "%OPENCLAW_MJS%" (
    cd /d "%CORE_DIR%"
    "%NODE_BIN%" "%OPENCLAW_MJS%" --version >> "%LOG_FILE%" 2>&1
    if %errorlevel%==0 (
        echo   ✓ OpenClaw 启动测试: 通过
    ) else (
        echo   ✗ OpenClaw 启动测试: 失败
        echo   [ERROR] OpenClaw failed to start >> "%LOG_FILE%"
        set /a ERROR_COUNT+=1
    )
) else (
    echo   ⚠ OpenClaw 启动测试: 跳过（文件缺失）
    echo   [SKIP] Cannot test - required files missing >> "%LOG_FILE%"
)

echo.
echo. >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"
echo Diagnostic complete. >> "%LOG_FILE%"
echo Error count: %ERROR_COUNT% >> "%LOG_FILE%"

echo   ========================================
echo     诊断完成
echo   ========================================
echo.

if %ERROR_COUNT%==0 (
    echo   ✅ 检查结果: 全部正常！
    echo   所有必需的组件都已就绪，可以正常使用。
    echo.
    echo   💡 下一步:
    echo   - 双击 Windows-Start.bat 启动服务
    echo   - 或查看 Welcome.html 了解使用说明
) else (
    echo   ❌ 检查结果: 发现 %ERROR_COUNT% 个问题
    echo.
    echo   💡 解决方案:
    echo   1. 查看 diagnostic-log.txt 了解详细错误
    echo   2. 尝试重新运行 Windows-Start.bat
    echo      （会自动安装缺失的依赖）
    echo   3. 如问题仍然存在，请查看 Welcome.html
    echo      或访问 github.com/dongsheng123132/u-claw
)
echo.
echo   📄 诊断日志已保存: diagnostic-log.txt
echo.
pause
