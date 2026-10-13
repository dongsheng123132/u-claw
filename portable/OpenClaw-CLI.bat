@echo off
chcp 65001 >nul 2>&1
title U-Claw Interactive CLI

REM 进阶用户：打开一个已配置好环境变量的命令行，可直接敲 openclaw 命令。
REM 复用与 Windows-Start.bat 一致的便携环境（盘内 Node + 盘内数据）。

set "UCLAW_DIR=%~dp0"
set "APP_DIR=%UCLAW_DIR%app"
set "CORE_DIR=%APP_DIR%\core"
set "DATA_DIR=%UCLAW_DIR%data"
set "NODE_DIR=%APP_DIR%\runtime\node-win-x64"
set "NODE_BIN=%NODE_DIR%\node.exe"

set "OPENCLAW_HOME=%DATA_DIR%"
set "OPENCLAW_STATE_DIR=%DATA_DIR%\.openclaw"
set "OPENCLAW_CONFIG_PATH=%DATA_DIR%\.openclaw\openclaw.json"
set "OPENCLAW_DISABLE_BONJOUR=1"

REM 把盘内 node 和 .bin 放到 PATH 最前，让 openclaw 命令可直接调用
set "PATH=%NODE_DIR%;%CORE_DIR%\node_modules\.bin;%PATH%"

if not exist "%NODE_BIN%" (
    echo   [ERROR] Node.js runtime not found
    echo   Please run Windows-Start.bat once first to set up the runtime.
    pause
    exit /b 1
)

if not exist "%CORE_DIR%\node_modules\.bin\openclaw.cmd" (
    echo   [ERROR] OpenClaw not installed yet
    echo   Please run Windows-Start.bat once first.
    pause
    exit /b 1
)

call "%UCLAW_DIR%lib\windows-runtime-env.bat" "%UCLAW_DIR%." "%NODE_BIN%"
if errorlevel 1 (
    pause
    exit /b 1
)

echo.
echo   ========================================
echo     U-Claw Interactive CLI
echo   ========================================
echo.
echo   You can now run the 'openclaw' command directly. Examples:
echo     openclaw --help          Show all commands
echo     openclaw chat            Open the terminal chat UI
echo     openclaw configure       Interactive setup (models, channels)
echo     openclaw doctor          Diagnose and repair
echo     openclaw gateway status  Check the running gateway
echo.
echo   Type 'exit' to close this window.
echo   ========================================
echo.

cmd /k
