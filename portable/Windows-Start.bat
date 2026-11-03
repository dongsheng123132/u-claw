@echo off
setlocal
chcp 65001 >nul 2>&1
REM Double-click default = WebUI in the DEFAULT BROWSER (no wrapper shell).
REM Why: lib/loading.html is the only page that offers the "Config / Change model"
REM entry; a standalone window that navigated straight into the dashboard hid that
REM entry (v2.3.8 shell regression, reverted).
REM Window modes stay opt-in: Windows-WebView.bat (WebView2) and Windows-App.bat
REM (Edge app) start this file with UCLAW_HEADLESS=1 so the backend does not open
REM a second UI next to the window they show themselves.
REM No non-ASCII in this file: GBK cmd.exe would mis-parse it.
:backend_start
title U-Claw - Portable AI Agent

echo.
echo   ========================================
echo     U-Claw - Portable AI Agent
echo   ========================================
echo.

set "UCLAW_DIR=%~dp0"
set "APP_DIR=%UCLAW_DIR%app"

REM Migration shim: rename old core-win to core for existing USB users
if exist "%APP_DIR%\core-win" if not exist "%APP_DIR%\core" ren "%APP_DIR%\core-win" core

set "CORE_DIR=%APP_DIR%\core"
set "DATA_DIR=%UCLAW_DIR%data"
set "STATE_DIR=%DATA_DIR%\.openclaw"
set "NODE_DIR=%APP_DIR%\runtime\node-win-x64"
set "NODE_BIN=%NODE_DIR%\node.exe"
set "NPM_BIN=%NODE_DIR%\npm.cmd"

REM --- Engine location (v2.5+: one engine-<version>.tar.gz on the stick) ---
REM Default: extract once to the host cache and run from there; if that fails,
REM extract under <stick>\engine\<version> and run from the stick. When no archive
REM is shipped (old sticks) the resolver reports "legacy" and nothing changes.
set "UCLAW_ENGINE_SOURCE=legacy"
set "UCLAW_ENGINE_ROOT=%UCLAW_DIR%."
REM Resolve through a temp file, not a backquoted for/f: cmd's quote stripping ate
REM the 2^>nul redirect and handed "2>nul" to PowerShell as an argument (CI proved it).
if not exist "%UCLAW_DIR%lib\engine-host.ps1" goto :uclaw_engine_resolved
set "UCLAW_ENGINE_ENV=%TEMP%\uclaw-engine-%RANDOM%-%RANDOM%.env"
powershell -NoProfile -ExecutionPolicy Bypass -File "%UCLAW_DIR%lib\engine-host.ps1" "%UCLAW_DIR%." > "%UCLAW_ENGINE_ENV%" 2>nul
if not exist "%UCLAW_ENGINE_ENV%" goto :uclaw_engine_resolved
for /f "usebackq tokens=1,* delims==" %%a in ("%UCLAW_ENGINE_ENV%") do (
    if "%%a"=="UCLAW_ENGINE_SOURCE" set "UCLAW_ENGINE_SOURCE=%%b"
    if "%%a"=="UCLAW_ENGINE_ROOT" set "UCLAW_ENGINE_ROOT=%%b"
    if "%%a"=="UCLAW_NODE_BIN" set "NODE_BIN=%%b"
    if "%%a"=="UCLAW_NODE_BIN" set "NODE_DIR=%%~dpb"
    if "%%a"=="UCLAW_CORE_DIR" set "CORE_DIR=%%b"
    if "%%a"=="UCLAW_APP_DIR" set "APP_DIR=%%b"
    if "%%a"=="UCLAW_ENGINE_MODE" set "UCLAW_ENGINE_MODE=%%b"
    if "%%a"=="UCLAW_ENGINE_ARCHIVE" set "UCLAW_ENGINE_ARCHIVE=%%b"
)
del "%UCLAW_ENGINE_ENV%" >nul 2>&1
:uclaw_engine_resolved
if not "%UCLAW_ENGINE_SOURCE%"=="legacy" echo   Engine: %UCLAW_ENGINE_SOURCE% ^(%UCLAW_ENGINE_ROOT%^)
if not "%UCLAW_ENGINE_SOURCE%"=="legacy" set "NPM_BIN=%NODE_DIR%\npm.cmd"

set "OPENCLAW_HOME=%DATA_DIR%"
set "OPENCLAW_STATE_DIR=%STATE_DIR%"
set "OPENCLAW_CONFIG_PATH=%STATE_DIR%\openclaw.json"
REM U-Claw opens the local dashboard directly; disable mDNS discovery on Windows
REM to avoid OpenClaw/@homebridge ciao crashes during bonjour re-advertise.
set "OPENCLAW_DISABLE_BONJOUR=1"
REM USB installs can't self-update (not a git checkout) and USB I/O makes an
REM in-place update risky anyway; upgrades ship as a new USB image instead.
set "OPENCLAW_NO_AUTO_UPDATE=1"

REM A damaged engine archive must not degrade into an online setup: the customer
REM needs to know the stick (or the download that produced it) is the problem.
if "%UCLAW_ENGINE_SOURCE%"=="broken" (
    echo.
    echo   ========================================
    echo   [ERROR] The engine archive on this stick is damaged.
    echo   ========================================
    echo   File: %UCLAW_ENGINE_ARCHIVE%
    echo   Please copy the whole U-Claw folder to the stick again, then retry.
    echo.
    pause
    exit /b 1
)

REM Bootstrap only when Node is missing; existing instances are checked before upgrades.
if not exist "%NODE_BIN%" (
    call "%UCLAW_DIR%setup.bat"
    if errorlevel 1 exit /b 1
)
for /f "tokens=*" %%v in ('"%NODE_BIN%" --version') do set NODE_VER=%%v
echo   Node.js: %NODE_VER%
echo.

set "PATH=%NODE_DIR%;%NODE_DIR%\node_modules\.bin;%PATH%"

REM Init data directories
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
if not exist "%STATE_DIR%" mkdir "%STATE_DIR%"
if not exist "%DATA_DIR%\memory" mkdir "%DATA_DIR%\memory"
if not exist "%DATA_DIR%\backups" mkdir "%DATA_DIR%\backups"
if not exist "%DATA_DIR%\logs" mkdir "%DATA_DIR%\logs"

REM Cold-start timing (data\.openclaw\boot-timing.jsonl; see lib/boot-timing.mjs).
REM Silent and cheap; Diagnose reads it with: node lib\boot-timing.mjs report <stateDir>
"%NODE_BIN%" "%UCLAW_DIR%lib\boot-timing.mjs" start "%STATE_DIR%" >nul 2>&1

REM Strip host-machine provider credential variables before starting the gateway.
REM If the PC happens to have DASHSCOPE_API_KEY etc. set, OpenClaw treats that
REM provider as configured, tries to install its plugin during startup migration,
REM and the plugin install needs a node_modules junction that exFAT cannot create
REM -- the gateway then never becomes ready ("works on A's PC, dead on B's PC").
REM Inheriting those vars would also silently spend the host owner's API credits.
set "UCLAW_STRIP_ENV="
"%NODE_BIN%" "%UCLAW_DIR%lib\strip-provider-env.mjs" > "%TEMP%\uclaw-strip.env" 2>nul
for /f "usebackq tokens=1,* delims==" %%a in ("%TEMP%\uclaw-strip.env") do (
    if "%%a"=="UCLAW_STRIP_ENV" set "UCLAW_STRIP_ENV=%%b"
)
del "%TEMP%\uclaw-strip.env" >nul 2>&1
if defined UCLAW_STRIP_ENV (
    for %%v in (%UCLAW_STRIP_ENV%) do set "%%v="
    echo   Stripped host provider env vars: %UCLAW_STRIP_ENV%
)

if defined NODE_COMPILE_CACHE echo   Cache on local disk: %UCLAW_CACHE_ROOT%

REM Default config (migrate legacy if present, otherwise create)
if not exist "%STATE_DIR%\openclaw.json" (
    if exist "%DATA_DIR%\config.json" (
        echo   Migrating legacy config...
        copy "%DATA_DIR%\config.json" "%STATE_DIR%\openclaw.json" >nul
        echo   Config migrated
    ) else (
        echo   First run - creating default config...
        copy "%UCLAW_DIR%default-config.json" "%STATE_DIR%\openclaw.json" >nul
        echo   Config created
    )
    echo.
)

REM Random per-stick gateway token (loopback only; see lib/gateway-token.mjs).
REM Runs before the instance-lock dashboard link and before official-provider-guard
REM fills defaults, so every link and the gateway itself agree on the same token.
REM The token CLI writes data\.openclaw\gateway-token (no trailing newline);
REM reading it with SET /P avoids the fragile FOR /F quoting when the drive path
REM contains spaces. Gateway auth keeps working because both sides read this value.
"%NODE_BIN%" "%UCLAW_DIR%lib\gateway-token.mjs" "%STATE_DIR%" >nul 2>&1
set "UCLAW_GATEWAY_TOKEN=uclaw"
if exist "%STATE_DIR%\gateway-token" set /p UCLAW_GATEWAY_TOKEN=<"%STATE_DIR%\gateway-token"

REM Startup cache acceleration. Session/identity/state stay portable on USB;
REM only the patched OpenClaw managed Chromium directory uses the local disk.
REM Do not inherit a browser root from the calling shell.
set "OPENCLAW_MANAGED_BROWSER_DIR="
"%NODE_BIN%" "%UCLAW_DIR%lib\portable-cache.mjs" "%STATE_DIR%" "%UCLAW_DIR%" > "%TEMP%\uclaw-cache.env" 2>nul
for /f "usebackq tokens=1,* delims==" %%a in ("%TEMP%\uclaw-cache.env") do (
    if "%%a"=="UCLAW_COMPILE_CACHE_DIR" set "NODE_COMPILE_CACHE=%%b"
    if "%%a"=="UCLAW_CACHE_ROOT" set "UCLAW_CACHE_ROOT=%%b"
    if "%%a"=="UCLAW_MANAGED_BROWSER_DIR" set "OPENCLAW_MANAGED_BROWSER_DIR=%%b"
)
del "%TEMP%\uclaw-cache.env" >nul 2>&1
if defined NODE_COMPILE_CACHE echo   Cache on local disk: %UCLAW_CACHE_ROOT%

REM Launcher-level single-instance guard. OpenClaw's own lock is created too late:
REM a second double-click otherwise picks another port and writes the same USB state.
REM PowerShell's parent is FOR /F's temporary cmd.exe; its grandparent is the cmd.exe
REM hosting this .bat and remains alive until the gateway exits.
REM Keep the lock with USB state, never in a reusable host cache shared by cloned drives.
set "INSTANCE_ROOT=%STATE_DIR%"
set "UCLAW_LAUNCHER_PID="
powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID); $q=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p.ParentProcessId); $q.ParentProcessId" > "%TEMP%\uclaw-pid.env" 2>nul
for /f "usebackq tokens=*" %%p in ("%TEMP%\uclaw-pid.env") do set "UCLAW_LAUNCHER_PID=%%p"
del "%TEMP%\uclaw-pid.env" >nul 2>&1
set "INSTANCE_STATUS=unavailable"
set "INSTANCE_PORT="
if defined UCLAW_LAUNCHER_PID (
    "%NODE_BIN%" "%UCLAW_DIR%lib\portable-instance-lock.mjs" acquire "%INSTANCE_ROOT%" "%STATE_DIR%" "%UCLAW_LAUNCHER_PID%" > "%TEMP%\uclaw-lock.env" 2>nul
    for /f "usebackq tokens=1,* delims==" %%a in ("%TEMP%\uclaw-lock.env") do (
        if "%%a"=="UCLAW_INSTANCE_STATUS" set "INSTANCE_STATUS=%%b"
        if "%%a"=="UCLAW_INSTANCE_PORT" set "INSTANCE_PORT=%%b"
    )
    del "%TEMP%\uclaw-lock.env" >nul 2>&1
)
if "%INSTANCE_STATUS%"=="existing" goto :reuse_existing_instance
if "%INSTANCE_STATUS%"=="busy" goto :reuse_existing_instance
goto :instance_check_done
:reuse_existing_instance
echo   U-Claw is already running; reusing the existing instance.
if not "%UCLAW_HEADLESS%"=="1" if defined INSTANCE_PORT start "" http://127.0.0.1:%INSTANCE_PORT%/#token=%UCLAW_GATEWAY_TOKEN%
if not defined INSTANCE_PORT echo   The existing instance is still starting. Please wait a moment.
exit /b 0
:instance_check_done

REM Upgrade missing or incompatible runtime and stale OpenClaw before startup.
set "UCLAW_SETUP_NEEDED=1"
if exist "%NODE_BIN%" call :uclaw_capture_requirements
if "%UCLAW_SETUP_NEEDED%"=="1" (
    echo   Updating portable runtime to the bundled OpenClaw version...
    call "%UCLAW_DIR%setup.bat"
    if errorlevel 1 goto :startup_failed
    if not exist "%NODE_BIN%" (
        echo   [ERROR] Node runtime missing after setup.
        pause
        goto :startup_failed
    )
)

REM Validate the actual runtime after setup before loading any user state.
set "UCLAW_SETUP_NEEDED=1"
call :uclaw_capture_requirements
if "%UCLAW_SETUP_NEEDED%"=="1" (
    echo   [ERROR] Portable runtime validation failed after setup.
    goto :startup_failed
)

"%NODE_BIN%" "%UCLAW_DIR%lib\boot-timing.mjs" mark "%STATE_DIR%" node-validated >nul 2>&1

REM Check dependencies
REM Select an explicit SDK strategy only after a generated-file probe proves
REM this filesystem changes identity on rename. Clear inherited overrides.
set "OPENCLAW_PORTABLE_RENAME_IDENTITY="
"%NODE_BIN%" "%UCLAW_DIR%lib\portable-filesystem.mjs" "%STATE_DIR%" > "%TEMP%\uclaw-fs.env" 2>nul
for /f "usebackq tokens=1,* delims==" %%a in ("%TEMP%\uclaw-fs.env") do (
    if "%%a"=="UCLAW_RENAME_IDENTITY" if "%%b"=="verify-content-with-lock" set "OPENCLAW_PORTABLE_RENAME_IDENTITY=verify-content-with-lock"
)
del "%TEMP%\uclaw-fs.env" >nul 2>&1

REM Note: avoid unescaped parens inside this block -- cmd.exe treats ) as block-end.
if not exist "%CORE_DIR%\node_modules" (
    echo   ========================================
    echo   [WARN] node_modules not found
    echo   ========================================
    echo   This release should ship with deps pre-installed.
    echo   Falling back to npm install ^(USB drives may take 20+ minutes^).
    echo.
    echo   TIP: Re-download u-claw-portable-*.zip from GitHub releases,
    echo        which includes pre-installed deps ^(~200 MB^).
    echo.
    echo   File system: NTFS recommended. exFAT/FAT32 will be very slow.
    echo.
    cd /d "%CORE_DIR%"
    REM Keep npm cache inside the portable app instead of system APPDATA.
    set "npm_config_cache=%APP_DIR%\.npm-cache"
    call "%NPM_BIN%" install --registry=https://registry.npmmirror.com --ignore-scripts --no-audit --no-fund --omit=dev
    echo.
    echo   Dependencies installed!
    echo.
)

REM Intranet/self-hosted model fix: keep the configured model host(s) off any
REM corporate HTTP_PROXY/HTTPS_PROXY. OpenClaw routes ALL fetch through the env
REM proxy when it is set, which breaks calls to internal model endpoints
REM (e.g. http://10.x / 192.168.x / a machine-room IP). Add those hosts + loopback
REM to NO_PROXY so they connect directly. Silent no-op when no proxy/model is set.
"%NODE_BIN%" "%UCLAW_DIR%lib\resolve-no-proxy.mjs" "%STATE_DIR%\openclaw.json" > "%TEMP%\uclaw-noproxy.env" 2>nul
for /f "usebackq tokens=1,* delims==" %%a in ("%TEMP%\uclaw-noproxy.env") do (
    if "%%a"=="UCLAW_NO_PROXY" set "NO_PROXY=%%b"
)
del "%TEMP%\uclaw-noproxy.env" >nul 2>&1
if defined NO_PROXY (
    set "no_proxy=%NO_PROXY%"
    REM Note: no unescaped parens in echo inside this IF block - cmd treats ) as block-end.
    echo   Direct-connect via NO_PROXY: %NO_PROXY%
)

REM Async update check (non-blocking, 5s timeout, silent failure)
REM Writes data\.openclaw\update-available.json if a newer version is on OSS.
REM Welcome.html / Config.html read this file and show a banner.
REM Version file lookup order: portable/OPENCLAW_VERSION (USB), then repo-root ../OPENCLAW_VERSION (dev)
set "VERSION_FILE=%UCLAW_DIR%OPENCLAW_VERSION"
if not exist "%VERSION_FILE%" set "VERSION_FILE=%UCLAW_DIR%..\OPENCLAW_VERSION"
if exist "%VERSION_FILE%" (
    start /B "" "%NODE_BIN%" "%UCLAW_DIR%lib\check-update.mjs" "%VERSION_FILE%" "%STATE_DIR%" >nul 2>&1
)

"%NODE_BIN%" "%UCLAW_DIR%lib\prepare-wallet.mjs" "%UCLAW_ENGINE_ROOT%" "%STATE_DIR%"
if errorlevel 1 goto :startup_failed

REM Start Config Server in background
echo   Starting Config Center on port 18788...
set "CONFIG_SERVER=%UCLAW_DIR%config-server"
set "RUNTIME_JSON=%STATE_DIR%\runtime.json"
del "%RUNTIME_JSON%" >nul 2>&1
start /B "" "%NODE_BIN%" "%CONFIG_SERVER%\server.js" >nul 2>&1

REM Wait for Config Server with polling instead of a fixed delay.
REM It writes runtime.json with the actual fallback port when ready.
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
    powershell -NoProfile -Command "try { (Get-Content -Raw '%RUNTIME_JSON%' | ConvertFrom-Json).configServerPort } catch {}" > "%TEMP%\uclaw-cfgport.env" 2>nul
for /f "usebackq tokens=*" %%p in ("%TEMP%\uclaw-cfgport.env") do set "CONFIG_PORT=%%p"
del "%TEMP%\uclaw-cfgport.env" >nul 2>&1
)
"%NODE_BIN%" "%UCLAW_DIR%lib\boot-timing.mjs" mark "%STATE_DIR%" config-center >nul 2>&1
echo   Config Center port: %CONFIG_PORT%

REM Find available gateway port after Config Center has bound its port.
REM NOTE: this loop deliberately avoids a parenthesized IF block. cmd.exe expands
REM %PORT% for every line inside "if (...)" at PARSE time of the whole block, before
REM any statement in it runs -- so "if %PORT% gtr 18799" would see the pre-increment
REM value and silently probe one port too many (v2.2.0 bug). Each statement below is
REM its own line outside any block, so %PORT% is re-read fresh before each one.
set PORT=18789
:check_port
netstat -ano | findstr "LISTENING" | findstr ":%PORT% " >nul 2>&1
if not %errorlevel%==0 goto :port_selected
echo   Port %PORT% in use, trying next...
set /a PORT+=1
if %PORT% gtr 18799 goto :no_gateway_port
goto :check_port
:no_gateway_port
echo   No available port 18789-18799
if not "%UCLAW_HEADLESS%"=="1" pause
goto :startup_failed
:port_selected

REM Publish the chosen port before launching child processes so a second click
REM reuses this exact instance instead of selecting 18790/18791.
if defined UCLAW_LAUNCHER_PID "%NODE_BIN%" "%UCLAW_DIR%lib\portable-instance-lock.mjs" publish "%INSTANCE_ROOT%" "%STATE_DIR%" "%UCLAW_LAUNCHER_PID%" %PORT% >nul 2>&1

REM Single source of truth for the actually-selected gateway port (v2.2.1).
REM config-server / Config.html / U-Claw.html now read this instead of guessing
REM configServerPort + 1 -- see lib/runtime-ports.mjs for why that guess broke
REM on machines where 18789 was already taken by something else.
"%NODE_BIN%" "%UCLAW_DIR%lib\runtime-ports.mjs" publish "%STATE_DIR%" gateway %PORT% >nul 2>&1

echo   Starting OpenClaw on port %PORT%...
echo.

REM Do not open Dashboard before the gateway is ready.
REM Slow USB drives may need tens of seconds to stage bundled deps.
REM Open the local startup page now; it redirects directly to the dashboard.

REM Open startup page with the gateway port and token in the query string.
echo   Opening startup screen...
set "LOADING_PATH=%UCLAW_DIR%lib\loading.html"
set "LOADING_URL=file:///%LOADING_PATH:\=/%?port=%PORT%&token=%UCLAW_GATEWAY_TOKEN%&configPort=%CONFIG_PORT%"
if not "%UCLAW_HEADLESS%"=="1" start "" "%LOADING_URL%"

echo   Xiapan Cloud wallet and recharge are available inside the WebUI.

REM Fallback watcher: if the startup page cannot poll from file URLs,
REM keep polling and reopen the dashboard after the gateway is ready.
if not "%UCLAW_HEADLESS%"=="1" start /B "" cmd /c ""%UCLAW_DIR%lib\wait-gateway.bat" %PORT% %CONFIG_PORT%"

REM Prewarm gateway in the background after it becomes ready.
start /B "" "%NODE_BIN%" "%UCLAW_DIR%lib\prewarm.mjs" %PORT% "%UCLAW_GATEWAY_TOKEN%" >nul 2>&1

echo.
echo   ========================================
echo   Starting OpenClaw Gateway on port %PORT%...
echo   First run on a USB drive may take 30-90 seconds
echo   (unpacking bundled components). Please wait;
echo   Open the WebUI device wallet for Xiapan Cloud balance and recharge.
echo   DO NOT close this window while using U-Claw!
echo   ========================================
echo.

REM Clean stale gateway lock from a previous crash / USB yank so OpenClaw won't
REM refuse to start with "gateway already running (pid XXXX)". Only locks whose
REM owning process is gone (or corrupt) are removed; a live instance is left alone.
"%NODE_BIN%" "%UCLAW_DIR%lib\clean-stale-lock.mjs" "%OPENCLAW_CONFIG_PATH%"
"%NODE_BIN%" "%UCLAW_DIR%lib\official-provider-guard.mjs" "%OPENCLAW_CONFIG_PATH%" 2>nul

REM Upgrade copied legacy agent databases with the official doctor before the
REM Gateway opens them. A failed migration keeps the backup and stops startup.
"%NODE_BIN%" "%UCLAW_DIR%lib\upgrade-session-schema.mjs" "%UCLAW_ENGINE_ROOT%"
if errorlevel 1 (
    echo   Legacy session database upgrade failed. Backup retained under data\backups.
    pause
    exit /b 1
)

"%NODE_BIN%" "%UCLAW_DIR%lib\boot-timing.mjs" mark "%STATE_DIR%" gateway-spawn >nul 2>&1

REM exFAT/FAT32 cannot complete OpenClaw's one-time package-lifecycle publish
REM (inode identity is unavailable -> EIO), and OpenClaw then refuses to start
REM with "package lifecycle is incomplete". This release installs with
REM --ignore-scripts and applies verified patches, so on such drives the pending
REM marker is cleared instead. NTFS keeps the full lifecycle completion.
set "UCLAW_LIFECYCLE="
"%NODE_BIN%" "%UCLAW_DIR%lib\skip-package-lifecycle.mjs" "%CORE_DIR%" > "%TEMP%\uclaw-lifecycle.env" 2>nul
for /f "usebackq tokens=1,* delims==" %%a in ("%TEMP%\uclaw-lifecycle.env") do (
    if "%%a"=="UCLAW_LIFECYCLE" set "UCLAW_LIFECYCLE=%%b"
)
del "%TEMP%\uclaw-lifecycle.env" >nul 2>&1
if "%UCLAW_LIFECYCLE%"=="skipped-unstable-rename-identity" echo   File system: exFAT/FAT32 - skipped dependency lifecycle completion.

cd /d "%CORE_DIR%"
set "OPENCLAW_MJS=%CORE_DIR%\node_modules\openclaw\openclaw.mjs"
"%NODE_BIN%" "%OPENCLAW_MJS%" gateway run --allow-unconfigured --port %PORT%
set "GW_EXIT=%errorlevel%"

if defined UCLAW_LAUNCHER_PID "%NODE_BIN%" "%UCLAW_DIR%lib\portable-instance-lock.mjs" release "%INSTANCE_ROOT%" "%STATE_DIR%" "%UCLAW_LAUNCHER_PID%" >nul 2>&1

echo.
if not "%GW_EXIT%"=="0" if not "%GW_EXIT%"=="-1073741510" (
    echo   OpenClaw exited unexpectedly ^(code %GW_EXIT%^)
)
if "%GW_EXIT%"=="78" (
    echo   [HINT] The Gateway rejected openclaw.json. Run OpenClaw-CLI.bat and then:
    echo          openclaw doctor --fix
)
echo   OpenClaw stopped.
if not "%UCLAW_HEADLESS%"=="1" pause

exit /b %GW_EXIT%
:startup_failed
if defined UCLAW_LAUNCHER_PID "%NODE_BIN%" "%UCLAW_DIR%lib\portable-instance-lock.mjs" release "%INSTANCE_ROOT%" "%STATE_DIR%" "%UCLAW_LAUNCHER_PID%" >nul 2>&1
exit /b 1

REM Read runtime-requirements.mjs through a temp file: a backquoted for/f loses the
REM 2^>nul redirect (CI proved PowerShell/node received "2>nul"), the variable stays
REM unset, and the launcher then runs an online setup on every start.
:uclaw_capture_requirements
set "UCLAW_REQ_ENV=%TEMP%\uclaw-req-%RANDOM%-%RANDOM%.env"
"%NODE_BIN%" "%UCLAW_DIR%lib\runtime-requirements.mjs" "%UCLAW_ENGINE_ROOT%" > "%UCLAW_REQ_ENV%" 2>nul
if not exist "%UCLAW_REQ_ENV%" goto :eof
for /f "usebackq tokens=1,* delims==" %%a in ("%UCLAW_REQ_ENV%") do (
    if "%%a"=="UCLAW_SETUP_NEEDED" set "UCLAW_SETUP_NEEDED=%%b"
)
del "%UCLAW_REQ_ENV%" >nul 2>&1
goto :eof
