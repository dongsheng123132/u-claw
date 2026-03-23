@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title U-Claw Portable Setup

set "SCRIPT_DIR=%~dp0"
set "APP_DIR=%SCRIPT_DIR%app"
set "CORE_DIR=%APP_DIR%\core"
set "RUNTIME_DIR=%APP_DIR%\runtime"
set "MIRROR=https://registry.npmmirror.com"
set "NODE_MIRROR=https://npmmirror.com/mirrors/node"
set "NODE_VERSION=v22.22.1"
set "ALL_PLATFORMS=false"
if "%~1"=="--all-platforms" set "ALL_PLATFORMS=true"

echo.
echo   ========================================
echo     U-Claw Portable Setup
echo   ========================================
echo.

echo   系统: Windows x64
echo.

REM ---- 1. Download Node.js (Current Platform - Windows) ----
set "NODE_DIR_NAME=node-win-x64"
set "NODE_TARGET=%RUNTIME_DIR%\%NODE_DIR_NAME%"

if exist "%NODE_TARGET%\node.exe" goto skip_node_download

echo   [DOWNLOAD] Downloading Node.js %NODE_VERSION% (win-x64)...
if not exist "%NODE_TARGET%" mkdir "%NODE_TARGET%" 2>nul

set "NODE_URL=%NODE_MIRROR%/%NODE_VERSION%/node-%NODE_VERSION%-win-x64.zip"
echo     URL: %NODE_URL%

set "TMP_ZIP=%TEMP%\node-win-x64-%RANDOM%.zip"
curl -fSL "%NODE_URL%" -o "%TMP_ZIP%"

set "DOWNLOAD_OK=0"
if %errorlevel% equ 0 set "DOWNLOAD_OK=1"

if "%DOWNLOAD_OK%"=="0" goto node_download_fail

echo     Extracting...
powershell -command "Expand-Archive -Path '%TMP_ZIP%' -DestinationPath '%TEMP%\node-extract' -Force" >nul 2>&1
xcopy /s /e /q /y "%TEMP%\node-extract\node-%NODE_VERSION%-win-x64\*" "%NODE_TARGET%\" >nul
rmdir /s /q "%TEMP%\node-extract" 2>nul
del /f /q "%TMP_ZIP%" 2>nul

if not exist "%NODE_TARGET%\node.exe" goto node_download_fail

echo   [OK] Node.js (win-x64) downloaded
goto node_download_done

:node_download_fail
echo   [ERROR] Node.js download failed
pause
exit /b 1

:skip_node_download
echo   [OK] Node.js (win-x64) exists, skipping
:node_download_done

REM ---- 1b. Download Node.js for Mac (only with --all-platforms) ----
if not "%ALL_PLATFORMS%"=="true" goto skip_mac_download

for %%p in (arm64 x64) do (
    set "MAC_NODE_TARGET=%RUNTIME_DIR%\node-mac-%%p"
    if exist "!MAC_NODE_TARGET!\bin\node" (
        echo   [OK] Node.js (mac-%%p) exists, skipping
    ) else (
        echo   [DOWNLOAD] Downloading Node.js %NODE_VERSION% (mac-%%p) for Mac support...
        if not exist "!MAC_NODE_TARGET!" mkdir "!MAC_NODE_TARGET!" 2>nul

        set "MAC_NODE_URL=%NODE_MIRROR%/%NODE_VERSION%/node-%NODE_VERSION%-darwin-%%p.tar.gz"
        echo     URL: !MAC_NODE_URL!

        set "TMP_TAR=%TEMP%\node-mac-%%p-%RANDOM%.tar.gz"
        curl -fSL "!MAC_NODE_URL!" -o "!TMP_TAR!"
        
        if !errorlevel! equ 0 (
            echo     Extracting...
            powershell -command "tar -xzf '!TMP_TAR!' -C '!MAC_NODE_TARGET!' --strip-components 1" >nul 2>&1
            del /f /q "!TMP_TAR!" 2>nul

            if exist "!MAC_NODE_TARGET!\bin\node" (
                echo   [OK] Node.js (mac-%%p) downloaded
            ) else (
                echo   [WARNING] Mac runtime download failed (does not affect current platform)
            )
        ) else (
            echo   [WARNING] Mac runtime download failed (does not affect current platform)
        )
    )
)

:skip_mac_download

REM ---- 2. Install OpenClaw ----
if exist "%CORE_DIR%\node_modules\openclaw" goto skip_openclaw_install

echo   [INSTALL] Installing OpenClaw...
if not exist "%CORE_DIR%" mkdir "%CORE_DIR%" 2>nul

if not exist "%CORE_DIR%\package.json" (
    echo { "name": "u-claw-core", "version": "1.0.0", "private": true, "dependencies": { "openclaw": "latest" } } > "%CORE_DIR%\package.json"
)

set "NPM_BIN=%NODE_TARGET%\npm.cmd"
cd /d "%CORE_DIR%"
call "%NPM_BIN%" install --prefix "%CORE_DIR%" --registry="%MIRROR%"

echo   [OK] OpenClaw installed
goto openclaw_install_done

:skip_openclaw_install
echo   [OK] OpenClaw exists, skipping
:openclaw_install_done

REM ---- 3. Install QQ Plugin ----
if exist "%CORE_DIR%\node_modules\@sliverp\qqbot" goto skip_qq_install

echo   [INSTALL] Installing QQ Plugin...
set "NPM_BIN=%NODE_TARGET%\npm.cmd"
cd /d "%CORE_DIR%"
call "%NPM_BIN%" install @sliverp/qqbot@latest --prefix "%CORE_DIR%" --registry="%MIRROR%" >nul 2>&1
echo   [OK] QQ Plugin installed
goto qq_install_done

:skip_qq_install
echo   [OK] QQ Plugin exists, skipping
:qq_install_done

REM ---- 4. Install China-optimized skills ----
set "SKILLS_CN=%SCRIPT_DIR%skills-cn"
set "SKILLS_TARGET=%CORE_DIR%\node_modules\openclaw\skills"

if not exist "%SKILLS_CN%" goto skip_skills_install
if not exist "%SKILLS_TARGET%" goto skip_skills_install

echo   [COPY] Installing China-optimized skills (skills-cn)...
set "SKILL_COUNT=0"
for /d %%s in ("%SKILLS_CN%\*") do (
    set "skill_name=%%~nxs"
    if not exist "%SKILLS_TARGET%\!skill_name!" (
        xcopy /s /e /q /y "%%s" "%SKILLS_TARGET%\!skill_name!\" >nul
        set /a SKILL_COUNT+=1
    )
)
echo   [OK] China skills installed (+%SKILL_COUNT% skills)

:skip_skills_install

REM ---- Done ----
echo.
echo   ========================================
echo     Setup Complete!
echo   ========================================
echo.
echo   To start:
echo     Mac:     bash Mac-Start.command
echo     Windows: Double-click Windows-Start.bat
echo.
echo   Directory structure:
echo     app\core\       - OpenClaw + dependencies
echo     app\runtime\    - Node.js %NODE_VERSION%
echo     data\           - Auto-generated after first run
echo.
if "%ALL_PLATFORMS%"=="true" (
    echo   Note: All platform runtimes downloaded, ready for cross-platform USB
) else (
    echo   Note: For cross-platform USB use setup.bat --all-platforms
)
echo.
pause
