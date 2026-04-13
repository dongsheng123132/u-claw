@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title U-Claw Menu

set "UCLAW_DIR=%~dp0"
set "CORE_DIR=%UCLAW_DIR%core"
set "DATA_DIR=%UCLAW_DIR%data"
set "STATE_DIR=%DATA_DIR%\.openclaw"
set "NODE_DIR=%UCLAW_DIR%runtime\node-win-x64"
set "NODE_BIN=%NODE_DIR%\node.exe"
set "NPM_BIN=%NODE_DIR%\npm.cmd"

set "OPENCLAW_HOME=%DATA_DIR%"
set "OPENCLAW_STATE_DIR=%STATE_DIR%"
set "OPENCLAW_CONFIG_PATH=%STATE_DIR%\openclaw.json"
set "PATH=%NODE_DIR%;%PATH%"

set "OPENCLAW_MJS=%CORE_DIR%\node_modules\openclaw\openclaw.mjs"
set "LOG_DIR=%DATA_DIR%\logs"
set "BACKUP_DIR=%DATA_DIR%\backups"

if not exist "%STATE_DIR%" mkdir "%STATE_DIR%"
if not exist "%DATA_DIR%\memory" mkdir "%DATA_DIR%\memory"
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:menu
cls
echo.
echo   ========================================
echo     U-Claw - Menu
echo     Portable AI Agent
echo   ========================================
echo.

if exist "%NODE_BIN%" (
    for /f "tokens=*" %%v in ('"%NODE_BIN%" --version') do echo   Node: %%v
) else (
    echo   [!] Node.js not found
)
if exist "%STATE_DIR%\openclaw.json" (echo   Config: OK) else (echo   Config: NOT SET)
echo.
echo   -- Config --
echo   [1] Setup wizard (model, API key)
echo   [2] Open web dashboard
echo.
echo   -- Chat Platforms --
echo   [3] QQ Bot (pre-installed, enter ID only)
echo   [4] Other platforms (Feishu/Telegram/WeChat)
echo.
echo   -- Maintenance --
echo   [5] Diagnostics
echo   [6] Backup config
echo   [7] Restore backup
echo   [8] System info
echo.
echo   -- Advanced --
echo   [9]  Kill residual processes
echo   [10] View logs
echo   [11] Factory reset
echo   [12] Uninstall
echo   [13] Check for updates
echo   [14] Disk cleanup
echo   [15] Plugin management
echo.
echo   [0] Exit
echo.
set /p choice="  Choose [0-15]: "

if "%choice%"=="1" goto :onboard
if "%choice%"=="2" goto :dashboard
if "%choice%"=="3" goto :qqbot
if "%choice%"=="4" goto :channels
if "%choice%"=="5" goto :doctor
if "%choice%"=="6" goto :backup
if "%choice%"=="7" goto :restore
if "%choice%"=="8" goto :sysinfo
if "%choice%"=="9" goto :killproc
if "%choice%"=="10" goto :viewlogs
if "%choice%"=="11" goto :factoryreset
if "%choice%"=="12" goto :uninstall
if "%choice%"=="13" goto :checkupdate
if "%choice%"=="14" goto :diskcleanup
if "%choice%"=="15" goto :plugins
if "%choice%"=="0" exit /b 0
echo   Invalid choice
pause
goto :menu

:onboard
echo.
echo   === Setup Wizard ===
echo.
echo   DeepSeek  - Custom Provider, URL: https://api.deepseek.com/v1
echo   Kimi      - Moonshot AI
echo   Qwen      - Qwen
echo   Doubao    - Volcano Engine
echo.
cd /d "%CORE_DIR%"
"%NODE_BIN%" "%OPENCLAW_MJS%" onboard
pause
goto :menu

:dashboard
echo.
echo   Starting gateway...
set PORT=18789
:find_port
netstat -an | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if !errorlevel!==0 (
    set /a PORT+=1
    if !PORT! gtr 18799 (echo   No available port & pause & goto :menu)
    goto :find_port
)
cd /d "%CORE_DIR%"
if not exist "%STATE_DIR%\openclaw.json" (
    (echo {"gateway":{"mode":"local","auth":{"token":"uclaw"}}})>"%STATE_DIR%\openclaw.json"
)

REM Read token from config
set "TOKEN=uclaw"
if exist "%STATE_DIR%\openclaw.json" (
    for /f "tokens=*" %%t in ('"%NODE_BIN%" -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log((c.gateway&&c.gateway.auth&&c.gateway.auth.token)||'uclaw')}catch(e){console.log('uclaw')}" "%STATE_DIR%\openclaw.json"') do set "TOKEN=%%t"
)

start /B "" cmd /c "timeout /t 3 /nobreak >nul && start http://127.0.0.1:!PORT!/#token=!TOKEN!"
"%NODE_BIN%" "%OPENCLAW_MJS%" gateway run --allow-unconfigured --force --port !PORT!
pause
goto :menu

:qqbot
echo.
echo   === QQ Bot Setup ===
echo.
echo   QQ plugin is pre-installed!
echo   You only need your AppID and AppSecret.
echo.
echo   Get them at: q.qq.com (create a bot)
echo.
set /p qqid="  AppID: "
set /p qqsecret="  AppSecret: "
if "%qqid%"=="" goto :qq_cancel
if "%qqsecret%"=="" goto :qq_cancel
cd /d "%CORE_DIR%"
"%NODE_BIN%" "%OPENCLAW_MJS%" channels add --channel qqbot --token "%qqid%:%qqsecret%"
echo.
set /p qqallow="  Your QQ number (allowlist, empty to skip): "
if not "%qqallow%"=="" "%NODE_BIN%" "%OPENCLAW_MJS%" config set channels.qqbot.allowFrom "%qqallow%"
echo.
echo   QQ Bot configured! Restart gateway to apply.
pause
goto :menu
:qq_cancel
echo   Cancelled.
pause
goto :menu

:channels
echo.
echo   === Other Platforms ===
echo.
echo   [a] Feishu (Lark)    - Enterprise
echo   [b] Telegram          - International
echo   [c] WeChat (plugin)   - iPad protocol
echo   [d] Discord
echo.
set /p ch_choice="  Choose (a-d, empty to cancel): "
if "%ch_choice%"=="a" (
    echo.
    echo   Feishu setup:
    echo     1. Visit open.feishu.cn/app to create an app
    echo     2. Get App ID and App Secret
    echo     3. Run Setup wizard [1] to bind
)
if "%ch_choice%"=="b" (
    echo.
    echo   Telegram setup:
    echo     1. Message @BotFather on Telegram
    echo     2. Create a bot and get the token
    echo     3. Run Setup wizard [1] to bind
)
if "%ch_choice%"=="c" (
    echo.
    echo   Installing WeChat plugin...
    cd /d "%CORE_DIR%"
    "%NODE_BIN%" "%OPENCLAW_MJS%" plugins install @icesword760/openclaw-wechat
    echo   WeChat plugin installed!
)
if "%ch_choice%"=="d" (
    echo.
    echo   Discord setup:
    echo     1. Visit discord.com/developers/applications
    echo     2. Create a bot and get the token
    echo     3. Run Setup wizard [1] to bind
)
echo.
pause
goto :menu

:doctor
cd /d "%CORE_DIR%"
"%NODE_BIN%" "%OPENCLAW_MJS%" doctor --repair
pause
goto :menu

:backup
echo.
set "TS=%date:~0,4%%date:~5,2%%date:~8,2%_%time:~0,2%%time:~3,2%"
set "TS=!TS: =0!"
set "BK=%BACKUP_DIR%\backup_!TS!"
mkdir "!BK!" 2>nul
set "BK_COUNT=0"
if exist "%STATE_DIR%\openclaw.json" (
    copy "%STATE_DIR%\openclaw.json" "!BK!\" >nul
    echo   + openclaw.json
    set /a BK_COUNT+=1
)
if exist "%DATA_DIR%\memory" (
    xcopy /s /q "%DATA_DIR%\memory" "!BK!\memory\" >nul 2>nul
    echo   + memory/
    set /a BK_COUNT+=1
)
echo.
if !BK_COUNT!==0 (
    echo   Nothing to backup.
    rmdir "!BK!" 2>nul
) else (
    for /f "tokens=*" %%s in ('powershell -command "(Get-ChildItem '!BK!' -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1KB" 2^>nul') do echo   Size: %%s KB
    echo   Backup saved: !BK!
)
pause
goto :menu

:restore
echo.
echo   === Restore Backup ===
echo.
echo   Available backups:
echo.
set "BK_NUM=0"
for /d %%d in ("%BACKUP_DIR%\*") do (
    set /a BK_NUM+=1
    echo   [!BK_NUM!] %%~nxd
    set "BK_PATH_!BK_NUM!=%%d"
)
if !BK_NUM!==0 (
    echo   No backups found.
    pause
    goto :menu
)
echo.
set /p rnum="  Choose backup number: "
if "!rnum!"=="" goto :menu
set "RESTORE_PATH=!BK_PATH_%rnum%!"
if "!RESTORE_PATH!"=="" (
    echo   Invalid choice.
    pause
    goto :menu
)
if exist "!RESTORE_PATH!\openclaw.json" (
    copy "!RESTORE_PATH!\openclaw.json" "%STATE_DIR%\" >nul
    echo   + Config restored
)
if exist "!RESTORE_PATH!\memory" (
    xcopy /s /q "!RESTORE_PATH!\memory" "%DATA_DIR%\memory\" >nul 2>nul
    echo   + Memory restored
)
echo.
echo   Restore complete!
pause
goto :menu

:sysinfo
echo.
echo   === System Info ===
echo.
echo   OS:     Windows
for /f "tokens=2 delims==" %%v in ('wmic os get Version /format:list 2^>nul ^| findstr "="') do echo   Ver:    %%v
for /f "tokens=2 delims==" %%v in ('wmic os get OSArchitecture /format:list 2^>nul ^| findstr "="') do echo   Arch:   %%v
for /f "tokens=2 delims==" %%v in ('wmic computersystem get TotalPhysicalMemory /format:list 2^>nul ^| findstr "="') do (
    set "MEM=%%v"
    set /a "MEM_GB=!MEM:~0,-9!"
    echo   Memory: !MEM_GB! GB
)
if exist "%NODE_BIN%" (
    for /f "tokens=*" %%v in ('"%NODE_BIN%" --version') do echo   Node:   %%v
)
echo   Path:   %UCLAW_DIR%
echo   Data:   %DATA_DIR%
for /f "tokens=*" %%s in ('powershell -command "(Get-ChildItem '%UCLAW_DIR%' -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB" 2^>nul') do echo   Size:   %%s MB
for /f "tokens=3" %%s in ('dir /-c "%UCLAW_DIR%." 2^>nul ^| findstr /c:"bytes free"') do echo   Free:   %%s bytes
echo.
if exist "%CORE_DIR%\node_modules\openclaw\package.json" (
    for /f "tokens=*" %%v in ('"%NODE_BIN%" -e "console.log(require('%CORE_DIR:\=/%/node_modules/openclaw/package.json').version)"') do echo   OpenClaw: %%v
)
pause
goto :menu

:killproc
echo.
echo   === Kill Residual Processes ===
echo.
echo   Checking ports 18789-18799...
set FOUND=0
for /l %%p in (18789,1,18799) do (
    netstat -ano | findstr ":%%p " | findstr "LISTENING" >nul 2>&1
    if not errorlevel 1 (
        echo   Port %%p: process found
        set FOUND=1
        for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%p " ^| findstr "LISTENING"') do (
            echo     PID: %%a
        )
    )
)

REM Also check for openclaw node processes
for /f "tokens=2" %%p in ('tasklist /fi "imagename eq node.exe" /fo csv /nh 2^>nul ^| findstr /i "node"') do (
    set "FOUND_NODE=1"
)

if "!FOUND!"=="0" (
    echo   No residual processes found on gateway ports.
    pause
    goto :menu
)

echo.
set /p killconfirm="  Kill these processes? (y/N): "
if /i not "!killconfirm!"=="y" (
    echo   Cancelled.
    pause
    goto :menu
)

for /l %%p in (18789,1,18799) do (
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%p " ^| findstr "LISTENING"') do (
        taskkill /PID %%a /F >nul 2>&1
    )
)
echo   Processes killed.
pause
goto :menu

:viewlogs
echo.
echo   === Log Management ===
echo.
set "LOG_FILE=%LOG_DIR%\gateway.log"
if not exist "%LOG_FILE%" (
    echo   No log file found. Start the gateway first.
    pause
    goto :menu
)
echo   [a] View last 50 lines
echo   [b] Open log in Notepad
echo   [c] Export log to Desktop
echo   [d] Clean logs older than 7 days
echo.
set /p logchoice="  Choose (a-d): "
if "%logchoice%"=="a" (
    echo.
    powershell -command "Get-Content '%LOG_FILE%' -Tail 50"
)
if "%logchoice%"=="b" (
    start notepad "%LOG_FILE%"
)
if "%logchoice%"=="c" (
    set "TS=%date:~0,4%%date:~5,2%%date:~8,2%_%time:~0,2%%time:~3,2%"
    set "TS=!TS: =0!"
    set "EXPORT=%USERPROFILE%\Desktop\uclaw-logs-!TS!.txt"
    copy "%LOG_FILE%" "!EXPORT!" >nul
    echo   Log exported: !EXPORT!
)
if "%logchoice%"=="d" (
    echo.
    echo   Cleaning logs older than 7 days...
    powershell -command "Get-ChildItem '%LOG_DIR%' -Filter '*.log' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -Force"
    echo   Old logs cleaned.
)
pause
goto :menu

:factoryreset
echo.
echo   === Factory Reset ===
echo.
echo   WARNING: This will delete all config and memory data!
echo.
echo   Actions:
echo     1. Auto-backup current config and memory
echo     2. Delete config (openclaw.json)
echo     3. Delete memory data
echo     4. Restore default config
echo.
echo   Type RESET to confirm:
set /p resetconfirm="  > "
if not "%resetconfirm%"=="RESET" (
    echo   Cancelled.
    pause
    goto :menu
)
echo.
echo   [1/4] Backing up...
set "TS=%date:~0,4%%date:~5,2%%date:~8,2%_%time:~0,2%%time:~3,2%"
set "TS=!TS: =0!"
set "BK=%BACKUP_DIR%\pre-reset_!TS!"
mkdir "!BK!" 2>nul
if exist "%STATE_DIR%\openclaw.json" copy "%STATE_DIR%\openclaw.json" "!BK!\" >nul 2>nul
if exist "%DATA_DIR%\memory" xcopy /s /q "%DATA_DIR%\memory" "!BK!\memory\" >nul 2>nul
echo   Backup saved: !BK!
echo   [2/4] Deleting config...
del "%STATE_DIR%\openclaw.json" 2>nul
del "%DATA_DIR%\config.json" 2>nul
echo   [3/4] Clearing memory...
rmdir /s /q "%DATA_DIR%\memory" 2>nul
mkdir "%DATA_DIR%\memory" 2>nul
echo   [4/4] Restoring default config...
(echo {"gateway":{"mode":"local","auth":{"token":"uclaw"}}})>"%STATE_DIR%\openclaw.json"
echo.
echo   Factory reset complete! Run Setup wizard [1] to reconfigure.
pause
goto :menu

:uninstall
echo.
echo   === Uninstall U-Claw ===
echo.
if exist "%USERPROFILE%\.uclaw" (
    echo   Found installed version: %USERPROFILE%\.uclaw
    for /f "tokens=*" %%s in ('powershell -command "(Get-ChildItem '%USERPROFILE%\.uclaw' -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB" 2^>nul') do echo   Size: %%s MB
    echo.
    echo   Type UNINSTALL to delete:
    set /p unconfirm="  > "
    if "!unconfirm!"=="UNINSTALL" (
        rmdir /s /q "%USERPROFILE%\.uclaw" 2>nul
        echo   Uninstalled!
    ) else (
        echo   Cancelled.
    )
) else (
    echo   Portable version - just delete this folder to uninstall.
    echo   Path: %UCLAW_DIR%
    echo.
    echo   For Electron desktop app:
    echo     Open Settings - Apps - find U-Claw - Uninstall
)
pause
goto :menu

:checkupdate
echo.
echo   === Check for Updates ===
echo.
if not exist "%CORE_DIR%\node_modules\openclaw\package.json" (
    echo   OpenClaw not installed.
    pause
    goto :menu
)
echo   Checking...
for /f "tokens=*" %%v in ('"%NODE_BIN%" -e "console.log(require('%CORE_DIR:\=/%/node_modules/openclaw/package.json').version)"') do set CUR_VER=%%v
echo   Current version: %CUR_VER%

echo   Fetching latest version...
for /f "tokens=*" %%v in ('"%NODE_BIN%" -e "const https=require('https');https.get('https://registry.npmmirror.com/openclaw/latest',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{console.log(JSON.parse(d).version)}catch(e){console.log('error')}})})" 2^>nul') do set LATEST_VER=%%v

if "!LATEST_VER!"=="" (
    echo   Could not fetch latest version (network issue?)
    pause
    goto :menu
)
if "!LATEST_VER!"=="error" (
    echo   Could not fetch latest version (network issue?)
    pause
    goto :menu
)

echo   Latest version:  !LATEST_VER!
echo.

if "!CUR_VER!"=="!LATEST_VER!" (
    echo   Already up to date!
    pause
    goto :menu
)

echo   New version available!
set /p doupdate="  Update now? (y/N): "
if /i not "!doupdate!"=="y" (
    echo   Cancelled.
    pause
    goto :menu
)

echo.
echo   Updating...
cd /d "%CORE_DIR%"
call "%NPM_BIN%" install openclaw@latest --registry=https://registry.npmmirror.com
for /f "tokens=*" %%v in ('"%NODE_BIN%" -e "console.log(require('./node_modules/openclaw/package.json').version)"') do set NEW_VER=%%v
echo.
echo   Updated! %CUR_VER% - %NEW_VER%
pause
goto :menu

:diskcleanup
echo.
echo   === Disk Cleanup ===
echo.
echo   Directory sizes:
if exist "%CORE_DIR%\node_modules" (
    for /f "tokens=*" %%s in ('powershell -command "(Get-ChildItem '%CORE_DIR%\node_modules' -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB" 2^>nul') do echo     node_modules: %%s MB
)
if exist "%DATA_DIR%\memory" (
    for /f "tokens=*" %%s in ('powershell -command "(Get-ChildItem '%DATA_DIR%\memory' -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1KB" 2^>nul') do echo     memory:       %%s KB
)
if exist "%BACKUP_DIR%" (
    for /f "tokens=*" %%s in ('powershell -command "(Get-ChildItem '%BACKUP_DIR%' -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1KB" 2^>nul') do echo     backups:      %%s KB
)
if exist "%LOG_DIR%" (
    for /f "tokens=*" %%s in ('powershell -command "(Get-ChildItem '%LOG_DIR%' -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1KB" 2^>nul') do echo     logs:         %%s KB
)
for /f "tokens=*" %%s in ('powershell -command "(Get-ChildItem '%UCLAW_DIR%' -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB" 2^>nul') do echo     Total:        %%s MB
echo.

REM Clean old backups (keep latest 3)
set "BK_COUNT=0"
for /d %%d in ("%BACKUP_DIR%\*") do set /a BK_COUNT+=1
if !BK_COUNT! gtr 3 (
    set /a OLD_COUNT=BK_COUNT-3
    echo   Found !BK_COUNT! backups, keeping latest 3.
    set /p delbk="  Delete !OLD_COUNT! old backups? (y/N): "
    if /i "!delbk!"=="y" (
        set "DEL_NUM=0"
        for /f "tokens=*" %%d in ('powershell -command "Get-ChildItem '%BACKUP_DIR%' -Directory | Sort-Object LastWriteTime | Select-Object -First !OLD_COUNT! | ForEach-Object { $_.FullName }"') do (
            rmdir /s /q "%%d" 2>nul
            set /a DEL_NUM+=1
        )
        echo   Cleaned !DEL_NUM! old backups.
    )
) else (
    echo   Backups: !BK_COUNT! (no cleanup needed)
)

REM Clean old logs (>7 days)
set "OLD_LOGS=0"
for /f "tokens=*" %%n in ('powershell -command "(Get-ChildItem '%LOG_DIR%' -Filter '*.log' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) }).Count" 2^>nul') do set OLD_LOGS=%%n
if !OLD_LOGS! gtr 0 (
    echo   Found !OLD_LOGS! logs older than 7 days.
    set /p dellog="  Delete old logs? (y/N): "
    if /i "!dellog!"=="y" (
        powershell -command "Get-ChildItem '%LOG_DIR%' -Filter '*.log' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -Force"
        echo   Old logs cleaned.
    )
) else (
    echo   Logs: no cleanup needed
)

REM Clean npm cache
echo.
set /p delcache="  Clean npm cache? (y/N): "
if /i "!delcache!"=="y" (
    call "%NPM_BIN%" cache clean --force 2>nul
    echo   npm cache cleaned.
)

echo.
for /f "tokens=*" %%s in ('powershell -command "(Get-ChildItem '%UCLAW_DIR%' -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB" 2^>nul') do echo   Total after cleanup: %%s MB
pause
goto :menu

:plugins
echo.
echo   === Plugin Management ===
echo.
echo   [a] List installed plugins
echo   [b] Install a plugin
echo   [c] Remove a plugin
echo.
set /p plgchoice="  Choose (a-c): "
cd /d "%CORE_DIR%"
if "%plgchoice%"=="a" (
    echo.
    "%NODE_BIN%" "%OPENCLAW_MJS%" plugins list
)
if "%plgchoice%"=="b" (
    echo.
    echo   Common plugins:
    echo     @icesword760/openclaw-wechat  - WeChat
    echo     @nicepkg/openclaw-plugin-qq   - QQ (community)
    echo.
    set /p plgname="  Plugin name (empty to cancel): "
    if not "!plgname!"=="" (
        echo.
        echo   Installing !plgname! ...
        "%NODE_BIN%" "%OPENCLAW_MJS%" plugins install "!plgname!"
        echo.
        echo   Done!
    ) else (
        echo   Cancelled.
    )
)
if "%plgchoice%"=="c" (
    echo.
    "%NODE_BIN%" "%OPENCLAW_MJS%" plugins list
    echo.
    set /p plgname="  Plugin to remove (empty to cancel): "
    if not "!plgname!"=="" (
        echo.
        echo   Removing !plgname! ...
        "%NODE_BIN%" "%OPENCLAW_MJS%" plugins remove "!plgname!"
        echo.
        echo   Done!
    ) else (
        echo   Cancelled.
    )
)
pause
goto :menu
