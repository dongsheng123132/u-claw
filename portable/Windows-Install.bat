@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title M-Claw - Install to Windows

echo.
echo   ========================================
echo     M-Claw 安装到 Windows
echo     从 U 盘离线安装
echo   ========================================
echo.

set "UCLAW_DIR=%~dp0"
set "APP_DIR=%UCLAW_DIR%app"
set "INSTALL_TARGET=%USERPROFILE%\.uclaw"
set "MIRROR=https://registry.npmmirror.com"
set "NODE_MIRROR=https://npmmirror.com/mirrors/node"
set "NODE_VER=v22.14.0"

REM ---- Step 1: Check environment ----
echo   [1/4] 检查环境...

set "USE_NODE=none"
set "USB_NODE=%APP_DIR%\runtime\node-win-x64\node.exe"

if exist "%USB_NODE%" (
    for /f "tokens=*" %%v in ('"%USB_NODE%" --version') do echo   Node.js: 使用 U 盘内的 %%v
    set "USE_NODE=usb"
) else (
    where node >nul 2>&1
    if !errorlevel!==0 (
        for /f "tokens=*" %%v in ('node --version') do (
            echo   Node.js: 检查系统版本 %%v
            set "SYS_VER=%%v"
        )
        REM Check if version >= 20
        for /f "tokens=1 delims=." %%m in ("!SYS_VER:v=!") do set "MAJOR=%%m"
        if !MAJOR! geq 20 (
            echo   Node.js: 使用系统的 !SYS_VER!
            set "USE_NODE=system"
        ) else (
            echo   Node.js: 系统版本太低 ^(!SYS_VER!^), 需要 v20+
            set "USE_NODE=download"
        )
    ) else (
        echo   Node.js: 未安装
        set "USE_NODE=download"
    )
)

set "USB_OPENCLAW=%APP_DIR%\core\node_modules\openclaw\openclaw.mjs"
if exist "%USB_OPENCLAW%" (
    echo   OpenClaw: 使用 U 盘内的
    set "USE_OPENCLAW=usb"
) else (
    echo   OpenClaw: U 盘内未找到，需要在线下载
    set "USE_OPENCLAW=download"
)

echo.

REM ---- Step 2: Check existing ----
if exist "%INSTALL_TARGET%" (
    echo   检测到已有安装: %INSTALL_TARGET%
    set /p OVERWRITE="  覆盖安装？(y/n): "
    if /i not "!OVERWRITE!"=="y" (
        echo   已取消
        pause
        exit /b 0
    )
    echo.
)

REM ---- Step 3: Create directories ----
echo   [2/4] 创建安装目录...
mkdir "%INSTALL_TARGET%" 2>nul
mkdir "%INSTALL_TARGET%\data\.openclaw" 2>nul
mkdir "%INSTALL_TARGET%\data\memory" 2>nul
mkdir "%INSTALL_TARGET%\data\backups" 2>nul
mkdir "%INSTALL_TARGET%\data\logs" 2>nul
echo.

REM ---- Step 4: Copy/Download Node.js ----
echo   [3/4] 安装 Node.js...

if "!USE_NODE!"=="usb" (
    echo   从 U 盘复制 Node.js...
    xcopy /s /e /q /y "%APP_DIR%\runtime\node-win-x64" "%INSTALL_TARGET%\runtime\node-win-x64\" >nul
    set "INSTALL_NODE=%INSTALL_TARGET%\runtime\node-win-x64\node.exe"
    set "INSTALL_NPM=%INSTALL_TARGET%\runtime\node-win-x64\npm.cmd"
    echo   Node.js 安装完成!
) else if "!USE_NODE!"=="system" (
    set "INSTALL_NODE=node"
    set "INSTALL_NPM=npm"
    echo   使用系统 Node.js
) else (
    echo   从国内镜像下载 Node.js %NODE_VER%...
    set "NODE_ZIP=node-%NODE_VER%-win-x64.zip"
    set "NODE_URL=%NODE_MIRROR%/%NODE_VER%/!NODE_ZIP!"
    echo   URL: !NODE_URL!
    echo.

    REM Download using curl (available on Windows 10+)
    curl -# -L "!NODE_URL!" -o "%TEMP%\!NODE_ZIP!"
    if !errorlevel! neq 0 (
        echo   [ERROR] 下载失败！请检查网络连接
        echo   也可以手动下载: !NODE_URL!
        pause
        exit /b 1
    )

    echo   解压中...
    mkdir "%INSTALL_TARGET%\runtime\node-win-x64" 2>nul
    powershell -command "Expand-Archive -Path '%TEMP%\!NODE_ZIP!' -DestinationPath '%TEMP%\node-extract' -Force"
    xcopy /s /e /q /y "%TEMP%\node-%NODE_VER%-win-x64\*" "%INSTALL_TARGET%\runtime\node-win-x64\" >nul
    rmdir /s /q "%TEMP%\node-extract" 2>nul
    del "%TEMP%\!NODE_ZIP!" 2>nul

    set "INSTALL_NODE=%INSTALL_TARGET%\runtime\node-win-x64\node.exe"
    set "INSTALL_NPM=%INSTALL_TARGET%\runtime\node-win-x64\npm.cmd"
    echo   Node.js 下载安装完成!
)
echo.

REM ---- Step 5: Copy/Download OpenClaw ----
echo   [4/4] 安装 OpenClaw...

if "!USE_OPENCLAW!"=="usb" (
    echo   从 U 盘复制 OpenClaw + 插件...
    xcopy /s /e /q /y "%APP_DIR%\core" "%INSTALL_TARGET%\core\" >nul
    echo   OpenClaw 安装完成!
) else (
    echo   从国内镜像下载 OpenClaw...
    mkdir "%INSTALL_TARGET%\core" 2>nul
    echo {"name":"u-claw-core","version":"1.0.0","private":true,"dependencies":{"openclaw":"latest"}} > "%INSTALL_TARGET%\core\package.json"
    cd /d "%INSTALL_TARGET%\core"
    call "!INSTALL_NPM!" install --registry=%MIRROR%
    call "!INSTALL_NPM!" install @sliverp/qqbot@latest --registry=%MIRROR%
    echo   OpenClaw 下载安装完成!
)

REM ---- Default config ----
if not exist "%INSTALL_TARGET%\data\.openclaw\openclaw.json" (
    echo {"gateway":{"mode":"local","auth":{"token":"uclaw"}}} > "%INSTALL_TARGET%\data\.openclaw\openclaw.json"
)

REM ---- Copy HTML pages ----
if exist "%UCLAW_DIR%Config.html" copy "%UCLAW_DIR%Config.html" "%INSTALL_TARGET%\" >nul
if exist "%UCLAW_DIR%M-Claw.html" copy "%UCLAW_DIR%M-Claw.html" "%INSTALL_TARGET%\" >nul

REM ---- Create launch script ----
(
echo @echo off
echo setlocal EnableDelayedExpansion
echo chcp 65001 ^>nul 2^>^&1
echo title M-Claw
echo set "DIR=%%~dp0"
echo set "NODE_BIN=%%DIR%%runtime\node-win-x64\node.exe"
echo if not exist "%%NODE_BIN%%" set "NODE_BIN=node"
echo set "OPENCLAW_MJS=%%DIR%%core\node_modules\openclaw\openclaw.mjs"
echo set "OPENCLAW_HOME=%%DIR%%data"
echo set "OPENCLAW_STATE_DIR=%%DIR%%data\.openclaw"
echo set "OPENCLAW_CONFIG_PATH=%%DIR%%data\.openclaw\openclaw.json"
echo.
echo REM Find available port
echo set PORT=18789
echo :check_port
echo netstat -an ^| findstr ":%%PORT%% " ^| findstr "LISTENING" ^>nul 2^>^&1
echo if %%errorlevel%%==0 (
echo     set /a PORT+=1
echo     if !PORT! gtr 18799 (echo No available port ^& pause ^& exit /b 1^)
echo     goto :check_port
echo ^)
echo.
echo cd /d "%%DIR%%core"
echo start /B "" cmd /c "timeout /t 3 /nobreak ^>nul ^&^& start http://127.0.0.1:!PORT!/#token=uclaw"
echo "%%NODE_BIN%%" "%%OPENCLAW_MJS%%" gateway run --allow-unconfigured --force --port !PORT!
echo pause
) > "%INSTALL_TARGET%\start.bat"

echo.
echo   ========================================
echo     安装成功!
echo   ========================================
echo.
echo   安装位置: %INSTALL_TARGET%
echo.
for /f "tokens=*" %%s in ('powershell -command "(Get-ChildItem '%INSTALL_TARGET%' -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB" 2^>nul') do echo   大小: %%s MB
echo.
echo   启动方式:
echo     双击 %INSTALL_TARGET%\start.bat
echo.
echo   首次使用:
echo     启动后浏览器自动打开配置页面
echo     选择 AI 模型 - 填写 API Key - 开始用
echo.
pause
