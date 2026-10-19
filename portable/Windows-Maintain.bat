@echo off
setlocal EnableExtensions DisableDelayedExpansion
title U-Claw Maintain
chcp 65001 >nul 2>&1

set "UCLAW_DIR=%~dp0"
set "DATA_DIR=%UCLAW_DIR%data"
set "STATE_DIR=%DATA_DIR%\.openclaw"
set "NODE_BIN=%UCLAW_DIR%app\runtime\node-win-x64\node.exe"
set "MAINT=%UCLAW_DIR%lib\portable-maintenance.mjs"

set "OPENCLAW_HOME=%DATA_DIR%"
set "OPENCLAW_STATE_DIR=%STATE_DIR%"
set "OPENCLAW_CONFIG_PATH=%STATE_DIR%\openclaw.json"
REM Keep OpenClaw from advertising on the LAN when tools in this menu run it.
set "OPENCLAW_DISABLE_BONJOUR=1"

if not exist "%NODE_BIN%" (
    echo   Node runtime not found: %NODE_BIN%
    echo   Run setup first, then start Windows-Maintain.bat again.
    pause
    exit /b 1
)
if not exist "%MAINT%" (
    echo   Missing helper: %MAINT%
    pause
    exit /b 1
)

:menu
cls
echo.
echo   ========================================
echo     U-Claw Maintain
echo   ========================================
echo.
echo   1  Model and wallet settings
echo   2  Diagnose
echo   3  Open local logs
echo   4  Backup
echo   5  Restore to a new folder
echo   6  Native OpenClaw CLI
echo   7  Stable release page
echo.
echo   0  Exit
echo.
set "CHOICE="
set /p "CHOICE=Select: "
if "%CHOICE%"=="1" goto :settings
if "%CHOICE%"=="2" goto :diagnose
if "%CHOICE%"=="3" goto :logs
if "%CHOICE%"=="4" goto :backup
if "%CHOICE%"=="5" goto :restore
if "%CHOICE%"=="6" goto :cli
if "%CHOICE%"=="7" goto :release
if "%CHOICE%"=="0" exit /b 0
goto :menu

:settings
for /f "usebackq delims=" %%u in (`""%NODE_BIN%" "%MAINT%" settings-url"`) do set "SETTINGS_URL=%%u"
if not defined SETTINGS_URL (
    echo   Could not get the settings URL. Start U-Claw first.
    pause
    goto :menu
)
start "" "%SETTINGS_URL%"
goto :menu

:diagnose
call "%UCLAW_DIR%Windows-Diagnose.bat"
goto :menu

:logs
set "LOG_DIR_OUT="
for /f "usebackq delims=" %%u in (`""%NODE_BIN%" "%MAINT%" logs-path"`) do set "LOG_DIR_OUT=%%u"
if not defined LOG_DIR_OUT (
    echo   Could not resolve the local log directory.
    pause
    goto :menu
)
start "" "%LOG_DIR_OUT%"
goto :menu

:backup
echo.
echo   Note: live session .jsonl files are skipped by openclaw backup (upstream treats them as volatile).
set "OUT="
set /p "OUT=Backup output path, Enter for default data/backups folder on this drive: "
if defined OUT (
    "%NODE_BIN%" "%MAINT%" backup --output "%OUT%"
) else (
    "%NODE_BIN%" "%MAINT%" backup
)
echo.
pause
goto :menu

:restore
echo.
echo   Note: live session .jsonl files are skipped by openclaw backup (upstream treats them as volatile).
echo   Restore writes to a fresh empty folder under data/backups on this drive.
echo   It never overwrites the live state; stop the Gateway before switching to the restored copy.
set "ARCHIVE="
set /p "ARCHIVE=Path of the backup archive to restore: "
if not defined ARCHIVE (
    echo   No archive path given.
    pause
    goto :menu
)
"%NODE_BIN%" "%MAINT%" restore "%ARCHIVE%"
echo.
pause
goto :menu

:cli
call "%UCLAW_DIR%OpenClaw-CLI.bat"
goto :menu

:release
start "" https://github.com/dongsheng123132/u-claw/releases
goto :menu
