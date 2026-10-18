@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul 2>&1
title U-Claw - Portable AI Agent

set "UCLAW_DIR=%~dp0"
set "DATA_DIR=%UCLAW_DIR%data"
set "STATE_DIR=%DATA_DIR%\.openclaw"
set "CHANNEL_FILE=%UCLAW_DIR%config\runtime-channel.json"
set "STARTUP_STATUS=%STATE_DIR%\startup-status.json"
set "OPENCLAW_HOME=%DATA_DIR%"
set "OPENCLAW_STATE_DIR=%STATE_DIR%"
set "OPENCLAW_CONFIG_PATH=%STATE_DIR%\openclaw.json"
set "OPENCLAW_DISABLE_BONJOUR=1"
if not defined LOCALAPPDATA set "LOCALAPPDATA=%USERPROFILE%\AppData\Local"

echo.
echo   ========================================
echo     U-Claw v3 - Portable AI Agent
echo   ========================================
echo.

if not exist "%DATA_DIR%" mkdir "%DATA_DIR%" >nul 2>&1
if not exist "%STATE_DIR%" mkdir "%STATE_DIR%" >nul 2>&1
if not exist "%DATA_DIR%\memory" mkdir "%DATA_DIR%\memory" >nul 2>&1
if not exist "%DATA_DIR%\backups" mkdir "%DATA_DIR%\backups" >nul 2>&1
if not exist "%DATA_DIR%\logs" mkdir "%DATA_DIR%\logs" >nul 2>&1
if not exist "%STATE_DIR%" goto :data_not_writable
call :write_status bootstrap 0

REM Show feedback before the first 34 MB Node archive is even unpacked.
set "LOADING_PATH=%UCLAW_DIR%lib\loading.html"
set "LOADING_URL=file:///%LOADING_PATH:\=/%?configPort=18788"
start "" "%LOADING_URL%"

if not exist "%CHANNEL_FILE%" goto :channel_missing
call :read_channel
if errorlevel 1 goto :channel_invalid
if not exist "%UCLAW_DIR%vendor\%UCLAW_NODE_ARCHIVE%" goto :node_seed_missing

REM A clean PC has no Node, so this is deliberately the only non-JS install step.
REM Hash/version are read from runtime-channel.json, never duplicated here.
set "BOOTSTRAP_HOST=%LOCALAPPDATA%\U-Claw"
call :bootstrap_node "%BOOTSTRAP_HOST%"
if errorlevel 1 (
    echo   Host cache is unavailable; using portable-strict runtime on this USB drive.
    call :bootstrap_node "%UCLAW_DIR%host"
    if errorlevel 1 goto :node_bootstrap_failed
)
set "NODE_BIN=%BOOTSTRAP_NODE_BIN%"

REM runtime-paths is the single authority for host-vs-portable-strict selection.
set "UCLAW_RUNTIME_MODE="
set "UCLAW_RUNTIME_HOST_ROOT="
set "UCLAW_RUNTIME_NODE_BIN="
for /f "usebackq tokens=1,* delims==" %%a in (`""%NODE_BIN%" "%UCLAW_DIR%lib\launcher-runtime.mjs" prepare "%UCLAW_DIR%" 2^>nul"`) do (
    if "%%a"=="UCLAW_RUNTIME_MODE" set "UCLAW_RUNTIME_MODE=%%b"
    if "%%a"=="UCLAW_RUNTIME_HOST_ROOT" set "UCLAW_RUNTIME_HOST_ROOT=%%b"
    if "%%a"=="UCLAW_RUNTIME_NODE_BIN" set "UCLAW_RUNTIME_NODE_BIN=%%b"
    if "%%a"=="UCLAW_RUNTIME_COMPILE_CACHE" set "NODE_COMPILE_CACHE=%%b"
    if "%%a"=="UCLAW_RUNTIME_LOGS" set "UCLAW_RUNTIME_LOGS=%%b"
)
if not defined UCLAW_RUNTIME_HOST_ROOT goto :runtime_paths_failed
if not exist "%UCLAW_RUNTIME_NODE_BIN%" goto :runtime_paths_failed
set "NODE_BIN=%UCLAW_RUNTIME_NODE_BIN%"
if "%UCLAW_RUNTIME_MODE%"=="portable-strict" echo   Portable-strict mode: host cache is unavailable; startup will be slower.

REM Keep gateway temp files inside the per-USB slot, not Windows TEMP.
set "UCLAW_GATEWAY_TMP=%UCLAW_RUNTIME_LOGS%\tmp"
if not exist "%UCLAW_GATEWAY_TMP%" mkdir "%UCLAW_GATEWAY_TMP%" >nul 2>&1
set "TEMP=%UCLAW_GATEWAY_TMP%"
set "TMP=%UCLAW_GATEWAY_TMP%"
REM U 盘拔掉/只读时 TEMP 不可写会炸依赖它的进程（MiMo SQLite 迁移实测报
REM 「unable to open database file」）。写探针失败就回退系统 TEMP，别硬用坏路径。
echo.>"%TEMP%\.uclaw-write-test" 2>nul
if not exist "%TEMP%\.uclaw-write-test" (
  set "TEMP=%LOCALAPPDATA%\Temp"
  set "TMP=%TEMP%"
) else (
  del "%TEMP%\.uclaw-write-test" >nul 2>&1
)

if not exist "%STATE_DIR%\openclaw.json" (
    (echo {"gateway":{"mode":"local","auth":{"token":"uclaw"}}})>"%STATE_DIR%\openclaw.json"
)

REM Config Center is dependency-free and serves loading.html's startup status endpoint.
set "CONFIG_SERVER=%UCLAW_DIR%config-server"
set "RUNTIME_JSON=%STATE_DIR%\runtime.json"
del "%RUNTIME_JSON%" >nul 2>&1
start /B "" "%NODE_BIN%" "%CONFIG_SERVER%\server.js" >nul 2>&1
set /a CFG_TRIES=0
:wait_config
if exist "%RUNTIME_JSON%" goto :config_ready
set /a CFG_TRIES+=1
if %CFG_TRIES% geq 20 goto :config_ready
ping -n 1 -w 300 127.0.0.1 >nul 2>&1
goto :wait_config
:config_ready
set "CONFIG_PORT=18788"
if exist "%RUNTIME_JSON%" (
    for /f "usebackq tokens=*" %%p in (`powershell -NoProfile -Command "try { (Get-Content -Raw '%RUNTIME_JSON%' | ConvertFrom-Json).configServerPort } catch {}" 2^>nul`) do set "CONFIG_PORT=%%p"
)

REM Config Center may have claimed a fallback port, so choose the gateway only now.
set PORT=18789
:check_port
netstat -an | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    if %PORT% geq 18799 goto :no_free_port
    set /a PORT+=1
    goto :check_port
)

REM The rest of first-run installation goes through the existing action core.
call :write_status runtime-seed 5
set "UCLAW_STARTUP_STATUS_FILE=%STARTUP_STATUS%"
echo   Installing offline runtime. First launch can take 3-5 minutes.
"%NODE_BIN%" "%UCLAW_DIR%uclaw.mjs" runtime.seed --usb-root "%UCLAW_DIR%" --host-root "%UCLAW_RUNTIME_HOST_ROOT%" --quiet
if errorlevel 1 goto :seed_failed
call :write_status activating 95
"%NODE_BIN%" "%UCLAW_DIR%uclaw.mjs" runtime.activate --usb-root "%UCLAW_DIR%" --host-root "%UCLAW_RUNTIME_HOST_ROOT%" --quiet
if errorlevel 1 goto :activate_failed

set "UCLAW_OPENCLAW_MJS="
for /f "usebackq tokens=1,* delims==" %%a in (`""%NODE_BIN%" "%UCLAW_DIR%lib\launcher-runtime.mjs" active "%UCLAW_DIR%" "%UCLAW_RUNTIME_HOST_ROOT%" 2^>nul"`) do (
    if "%%a"=="UCLAW_OPENCLAW_MJS" set "UCLAW_OPENCLAW_MJS=%%b"
)
if not exist "%UCLAW_OPENCLAW_MJS%" goto :active_entry_missing

REM Do not inherit a host user's provider credentials or proxy routing by accident.
set "UCLAW_STRIP_ENV="
for /f "usebackq tokens=1,* delims==" %%a in (`""%NODE_BIN%" "%UCLAW_DIR%lib\strip-provider-env.mjs" 2^>nul"`) do (
    if "%%a"=="UCLAW_STRIP_ENV" set "UCLAW_STRIP_ENV=%%b"
)
if defined UCLAW_STRIP_ENV for %%v in (%UCLAW_STRIP_ENV%) do set "%%v="
for /f "usebackq tokens=1,* delims==" %%a in (`""%NODE_BIN%" "%UCLAW_DIR%lib\resolve-no-proxy.mjs" "%STATE_DIR%\openclaw.json" 2^>nul"`) do (
    if "%%a"=="UCLAW_NO_PROXY" set "NO_PROXY=%%b"
)
if defined NO_PROXY set "no_proxy=%NO_PROXY%"

REM Keep the existing action binding; v3 slim packages may intentionally skip it.
"%NODE_BIN%" "%UCLAW_DIR%uclaw.mjs" plugin.wechat.install --quiet
"%NODE_BIN%" "%UCLAW_DIR%uclaw.mjs" lock.clean --quiet

set "MODEL_CONFIGURED=0"
for /f "usebackq tokens=1,* delims==" %%a in (`""%NODE_BIN%" "%UCLAW_DIR%lib\check-model-configured.mjs" "%STATE_DIR%\openclaw.json" 2^>nul"`) do (
    if "%%a"=="UCLAW_MODEL_CONFIGURED" set "MODEL_CONFIGURED=%%b"
)
if not "%MODEL_CONFIGURED%"=="1" start "" http://127.0.0.1:%CONFIG_PORT%/

call :write_status starting-gateway 98 %PORT%
echo   Starting OpenClaw on port %PORT%...
"%NODE_BIN%" "%UCLAW_OPENCLAW_MJS%" gateway run --allow-unconfigured --force --port %PORT%
set "GW_EXIT=%errorlevel%"
call :write_status stopped 0
if not "%GW_EXIT%"=="0" if not "%GW_EXIT%"=="-1073741510" echo   OpenClaw exited unexpectedly ^(code %GW_EXIT%^)
pause
exit /b %GW_EXIT%

:read_channel
for /f "usebackq tokens=1,* delims==" %%a in (`powershell -NoProfile -Command "$c=Get-Content -Raw -LiteralPath $env:CHANNEL_FILE ^| ConvertFrom-Json; $t=$c.node.targets.'win-x64'; 'UCLAW_NODE_VERSION='+$c.node.version; 'UCLAW_NODE_ARCHIVE='+$t.archive; 'UCLAW_NODE_SHA256='+$t.sha256" 2^>nul`) do (
    if "%%a"=="UCLAW_NODE_VERSION" set "UCLAW_NODE_VERSION=%%b"
    if "%%a"=="UCLAW_NODE_ARCHIVE" set "UCLAW_NODE_ARCHIVE=%%b"
    if "%%a"=="UCLAW_NODE_SHA256" set "UCLAW_NODE_SHA256=%%b"
)
if not defined UCLAW_NODE_VERSION exit /b 1
if not defined UCLAW_NODE_ARCHIVE exit /b 1
if not defined UCLAW_NODE_SHA256 exit /b 1
exit /b 0

:bootstrap_node
set "BOOTSTRAP_NODE_HOME=%~1\shared\runtime\node-v%UCLAW_NODE_VERSION%-win-x64"
set "BOOTSTRAP_NODE_BIN=%BOOTSTRAP_NODE_HOME%\node.exe"
if exist "%BOOTSTRAP_NODE_BIN%" exit /b 0
set "UCLAW_NODE_DEST=%BOOTSTRAP_NODE_HOME%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $archive=Join-Path $env:UCLAW_DIR ('vendor\'+$env:UCLAW_NODE_ARCHIVE); if (-not (Test-Path -LiteralPath $archive)) { throw 'offline Node seed is missing' }; $actual=(Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant(); if ($actual -ne $env:UCLAW_NODE_SHA256.ToLowerInvariant()) { throw 'offline Node seed SHA256 mismatch' }; $dest=$env:UCLAW_NODE_DEST; $parent=Split-Path -Parent $dest; New-Item -ItemType Directory -Force -Path $parent ^| Out-Null; $stage=$dest+'.staging-'+$PID; Expand-Archive -LiteralPath $archive -DestinationPath $stage -Force; $root=Get-ChildItem -LiteralPath $stage -Directory ^| Select-Object -First 1; if ($null -eq $root) { $root=Get-Item -LiteralPath $stage }; if (-not (Test-Path -LiteralPath (Join-Path $root.FullName 'node.exe'))) { throw 'Node archive did not contain node.exe' }; if (Test-Path -LiteralPath $dest) { Move-Item -LiteralPath $dest -Destination ($dest+'.corrupt-'+$PID) -Force }; Move-Item -LiteralPath $root.FullName -Destination $dest -Force; if (-not (Test-Path -LiteralPath (Join-Path $dest 'node.exe'))) { throw 'Node extraction verification failed' }" >nul 2>&1
if errorlevel 1 exit /b 1
if not exist "%BOOTSTRAP_NODE_BIN%" exit /b 1
exit /b 0

:write_status
if "%~3"=="" (
    (echo {"phase":"%~1","pct":%~2})>"%STARTUP_STATUS%"
) else (
    (echo {"phase":"%~1","pct":%~2,"gateway_port":%~3})>"%STARTUP_STATUS%"
)
exit /b 0

:data_not_writable
echo   [ERROR] USB data directory is not writable.
goto :failed
:channel_missing
echo   [ERROR] runtime-channel.json is missing.
goto :failed
:channel_invalid
echo   [ERROR] runtime-channel.json is invalid for Windows x64.
goto :failed
:node_seed_missing
echo   [ERROR] Offline Node seed is missing from vendor.
goto :failed
:node_bootstrap_failed
echo   [ERROR] Could not verify and extract the offline Node runtime.
goto :failed
:runtime_paths_failed
echo   [ERROR] Neither the host cache nor USB fallback runtime path is writable.
goto :failed
:seed_failed
echo   [ERROR] Offline runtime installation failed. See the startup status and action logs.
goto :failed
:activate_failed
echo   [ERROR] Runtime activation failed; the previous kernel remains available.
goto :failed
:active_entry_missing
echo   [ERROR] The active OpenClaw kernel entry is missing.
goto :failed
:no_free_port
echo   [ERROR] No available port in 18789-18799.
:failed
call :write_status failed 0
pause
exit /b 1
