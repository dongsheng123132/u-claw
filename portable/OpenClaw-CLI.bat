@echo off
chcp 65001 >nul 2>&1
title U-Claw Interactive CLI

REM Advanced users: open a console with the portable environment already configured, so the "openclaw" command can be typed directly.
REM Reuses the same portable environment as Windows-Start.bat (on-drive Node + on-drive data).

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

REM Put the on-drive node and .bin first on PATH so the openclaw command resolves directly.
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
