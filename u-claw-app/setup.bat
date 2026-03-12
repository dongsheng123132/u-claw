@echo off
chcp 65001 >nul 2>&1
title U-Claw Desktop App Setup

echo.
echo   ========================================
echo     U-Claw Desktop App Setup
echo     一键安装开发环境
echo   ========================================
echo.

set "APP_DIR=%~dp0"
set "NODE_VER=v22.14.0"
set "MIRROR=https://registry.npmmirror.com"
set "NODE_MIRROR=https://npmmirror.com/mirrors/node"

REM ---- 1. Check Node.js ----
echo   [1/4] 检查 Node.js...

where node >nul 2>&1
if %errorlevel%==0 (
    for /f "tokens=*" %%v in ('node --version') do set SYS_VER=%%v
    echo   系统 Node.js: %SYS_VER%
    set "NODE_OK=1"
) else (
    set "NODE_OK=0"
)

if "%NODE_OK%"=="0" (
    echo.
    echo   [!] 未检测到 Node.js
    echo.
    echo   请先安装 Node.js v22+:
    echo.
    echo   方法1 - 官网下载:
    echo     https://nodejs.org/
    echo.
    echo   方法2 - 国内镜像（推荐）:
    echo     https://npmmirror.com/mirrors/node/%NODE_VER%/
    echo     下载 node-%NODE_VER%-win-x64.zip，解压后加到 PATH
    echo.
    echo   方法3 - Scoop（包管理器）:
    echo     scoop install nodejs-lts
    echo.
    echo   安装完成后重新运行此脚本。
    echo.
    pause
    exit /b 1
)

echo.

REM ---- 2. Install npm dependencies ----
echo   [2/4] 安装依赖 (国内镜像)...
echo   镜像: %MIRROR%
echo.

cd /d "%APP_DIR%"

set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

call npm install --registry=%MIRROR%
echo.
echo   依赖安装完成!
echo.

REM ---- 3. Download Node.js runtime for packaging ----
echo   [3/4] 准备打包用 Node.js runtime...

set "RUNTIME_DIR=%APP_DIR%resources\runtime\node-win32-x64"
if exist "%RUNTIME_DIR%\node.exe" (
    echo   Runtime 已就绪
) else (
    echo   下载 Node.js %NODE_VER% runtime (win-x64)...
    mkdir "%RUNTIME_DIR%" 2>nul

    set "ZIP_NAME=node-%NODE_VER%-win-x64.zip"
    set "URL=%NODE_MIRROR%/%NODE_VER%/%ZIP_NAME%"

    echo   下载中...
    curl -# -L "%URL%" -o "%TEMP%\%ZIP_NAME%"

    echo   解压中...
    powershell -Command "Expand-Archive -Path '%TEMP%\%ZIP_NAME%' -DestinationPath '%TEMP%\node-extract' -Force"
    xcopy /s /e /q "%TEMP%\node-extract\node-%NODE_VER%-win-x64\*" "%RUNTIME_DIR%\" >nul
    rd /s /q "%TEMP%\node-extract" 2>nul
    del "%TEMP%\%ZIP_NAME%" 2>nul

    echo   Runtime 下载完成!
)
echo.

REM ---- 4. Done ----
echo   [4/4] 完成!
echo.
echo   ========================================
echo     安装成功!
echo   ========================================
echo.
echo   接下来你可以:
echo.
echo   运行开发版:
echo     cd u-claw-app
echo     npm run dev
echo.
echo   打包 EXE:
echo     npm run build:win
echo.
echo   产出在 release\ 目录
echo.

set /p RUN="  现在启动开发版？(y/n): "
if /i "%RUN%"=="y" (
    echo.
    echo   启动 U-Claw...
    npm run dev
)

pause
