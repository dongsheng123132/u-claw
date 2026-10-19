@echo off
chcp 65001 >nul 2>&1
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

set "OPENCLAW_HOME=%DATA_DIR%"
set "OPENCLAW_STATE_DIR=%STATE_DIR%"
set "OPENCLAW_CONFIG_PATH=%STATE_DIR%\openclaw.json"
REM U-Claw opens the local dashboard directly; disable mDNS discovery on Windows
REM to avoid OpenClaw/@homebridge ciao crashes during bonjour re-advertise.
set "OPENCLAW_DISABLE_BONJOUR=1"
REM USB installs can't self-update (not a git checkout) and USB I/O makes an
REM in-place update risky anyway; upgrades ship as a new USB image instead.
set "OPENCLAW_NO_AUTO_UPDATE=1"

REM Check runtime - missing? Auto-run setup (first run on a new PC / incomplete copy).
REM setup.bat is fully non-interactive on the happy path; only failure branches pause.
if not exist "%NODE_BIN%" (
    echo   [WARN] Node.js runtime not found. Auto-running setup ^(1-3 min, needs network^)...
    echo.
    call "%UCLAW_DIR%setup.bat"
    if not exist "%NODE_BIN%" (
        echo   [ERROR] Setup finished but runtime still missing: %NODE_BIN%
        echo   Retry manually: setup.bat
        pause
        exit /b 1
    )
    echo   [OK] Environment ready, continuing startup.
    echo.
)

for /f "tokens=*" %%v in ('"%NODE_BIN%" --version') do set NODE_VER=%%v
echo   Node.js: %NODE_VER%
echo.

set "PATH=%NODE_DIR%;%NODE_DIR%\node_modules\.bin;%PATH%"

REM Read kernel mode (lite/full). Default lite. The helper validates the enum and
REM only ever returns "lite" or "openclaw" -- raw file content is never trusted.
set "CORE_MODE=lite"
for /f "usebackq tokens=*" %%m in (`""%NODE_BIN%" "%UCLAW_DIR%lib\core-mode.mjs" get "%STATE_DIR%" 2^>nul"`) do set "CORE_MODE=%%m"
if not "%CORE_MODE%"=="openclaw" set "CORE_MODE=lite"

REM Validate before creating or migrating user state.
REM Lite (PicoClaw) does not need OpenClaw installed -- pass --lite so preflight skips
REM the OpenClaw version/platform check (a clean USB with only PicoClaw would be wrongly rejected).
if "%CORE_MODE%"=="lite" (
    call "%UCLAW_DIR%lib\windows-runtime-env.bat" "%UCLAW_DIR%." "%NODE_BIN%" --lite
) else (
    call "%UCLAW_DIR%lib\windows-runtime-env.bat" "%UCLAW_DIR%." "%NODE_BIN%"
)
if errorlevel 1 (
    pause
    exit /b 1
)

REM Strip host-machine provider credential variables before starting any kernel.
REM If the PC happens to have DASHSCOPE_API_KEY etc. set, OpenClaw treats that
REM provider as configured, tries to install its plugin during startup migration,
REM and the plugin install needs a node_modules junction that exFAT cannot create
REM -- the gateway then never becomes ready ("works on A's PC, dead on B's PC").
REM Inheriting those vars would also silently spend the host owner's API credits.
set "UCLAW_STRIP_ENV="
for /f "usebackq tokens=1,* delims==" %%a in (`""%NODE_BIN%" "%UCLAW_DIR%lib\strip-provider-env.mjs" 2^>nul"`) do (
    if "%%a"=="UCLAW_STRIP_ENV" set "UCLAW_STRIP_ENV=%%b"
)
if defined UCLAW_STRIP_ENV (
    for %%v in (%UCLAW_STRIP_ENV%) do set "%%v="
    echo   Stripped host provider env vars: %UCLAW_STRIP_ENV%
)

REM Startup cache acceleration via the shared resolver helper (lib\portable-cache-env.bat).
REM Session/identity/state stay portable on USB; compile/npm/temp/log/browser dirs are local.
REM The helper clears any inherited browser root itself; no local cache = hard stop.
REM Shared chain: runs BEFORE the Lite/Full branch (Lite uses the same cache contract).
set "OPENCLAW_MANAGED_BROWSER_DIR="
call "%UCLAW_DIR%lib\portable-cache-env.bat" "%STATE_DIR%" "%UCLAW_DIR%"
if errorlevel 1 (
    echo   [ERROR] No writable local cache directory on this PC.
    echo   U-Claw will not write cache to the portable drive. Fix disk space or permissions and start again.
    pause
    exit /b 1
)
if defined UCLAW_CACHE_ROOT echo   Cache on local disk: %UCLAW_CACHE_ROOT%

REM Launcher-level single-instance guard. OpenClaw's own lock is created too late:
REM a second double-click otherwise picks another port and writes the same USB state.
REM PowerShell's parent is FOR /F's temporary cmd.exe; its grandparent is the cmd.exe
REM hosting this .bat and remains alive until the gateway exits.
REM Keep the lock with USB state, never in a reusable host cache shared by cloned drives.
REM Shared chain: both Lite and Full are single-instance. In Lite mode the running
REM kernel is the PicoClaw CLI (no web dashboard), so a second click must NOT open
REM a fake Dashboard URL -- it just reports the running instance and exits.
set "INSTANCE_ROOT=%STATE_DIR%"
set "UCLAW_LAUNCHER_PID="
for /f "usebackq tokens=*" %%p in (`powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID); $q=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p.ParentProcessId); $q.ParentProcessId" 2^>nul`) do set "UCLAW_LAUNCHER_PID=%%p"
set "INSTANCE_STATUS=unavailable"
set "INSTANCE_PORT="
if defined UCLAW_LAUNCHER_PID (
    for /f "usebackq tokens=1,* delims==" %%a in (`""%NODE_BIN%" "%UCLAW_DIR%lib\portable-instance-lock.mjs" acquire "%INSTANCE_ROOT%" "%STATE_DIR%" "%UCLAW_LAUNCHER_PID%" 2^>nul"`) do (
        if "%%a"=="UCLAW_INSTANCE_STATUS" set "INSTANCE_STATUS=%%b"
        if "%%a"=="UCLAW_INSTANCE_PORT" set "INSTANCE_PORT=%%b"
    )
)
if "%INSTANCE_STATUS%"=="existing" goto :reuse_existing_instance
if "%INSTANCE_STATUS%"=="busy" goto :reuse_existing_instance
goto :instance_check_done
:reuse_existing_instance
echo   U-Claw is already running; reusing the existing instance.
REM Only Full (OpenClaw) has a dashboard to focus. In Lite mode there is no
REM dashboard URL to open -- do not fake one (CORE_MODE is read before this point).
if "%CORE_MODE%"=="openclaw" if defined INSTANCE_PORT start "" http://127.0.0.1:%INSTANCE_PORT%/#token=uclaw
if not defined INSTANCE_PORT echo   The existing instance is still starting. Please wait a moment.
exit /b 0
:instance_check_done

REM Default config (migrate legacy if present, otherwise create).
REM Full (OpenClaw) needs openclaw.json before the gateway starts; Lite keeps its
REM own data domain (data/picoclaw) and does not read this file.
if not exist "%STATE_DIR%\openclaw.json" (
    if exist "%DATA_DIR%\config.json" (
        echo   Migrating legacy config...
        copy "%DATA_DIR%\config.json" "%STATE_DIR%\openclaw.json" >nul
        echo   Config migrated
    ) else (
        echo   First run - creating default config...
        (echo {"gateway":{"mode":"local","auth":{"token":"uclaw"}},"update":{"checkOnStart":false,"auto":{"enabled":false}}})>"%STATE_DIR%\openclaw.json"
        echo   Config created
    )
    echo.
)

REM Lite skips session migration and dependency installation.
if "%CORE_MODE%"=="lite" goto :shared_config_start

REM Upgrade copied legacy sessions before Config Center or Gateway writes state.
REM OpenClaw-specific: Lite does not use OpenClaw sessions.
"%NODE_BIN%" "%UCLAW_DIR%lib\upgrade-session-schema.mjs" "%UCLAW_DIR%."
if errorlevel 1 (
    pause
    exit /b 1
)

REM Check dependencies
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
    REM npm cache comes from portable-cache-env.bat (local disk), never on the portable drive.
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
for /f "usebackq tokens=1,* delims==" %%a in (`""%NODE_BIN%" "%UCLAW_DIR%lib\resolve-no-proxy.mjs" "%STATE_DIR%\openclaw.json" 2^>nul"`) do (
    if "%%a"=="UCLAW_NO_PROXY" set "NO_PROXY=%%b"
)
if defined NO_PROXY (
    set "no_proxy=%NO_PROXY%"
    REM Note: no unescaped parens in echo inside this IF block - cmd treats ) as block-end.
    echo   Direct-connect via NO_PROXY: %NO_PROXY%
)

REM Update check on startup is retired: no stale manifest reads, no OSS requests.
REM Upgrades ship as a verified stable bundle; users open the release page manually.

REM The WeChat plugin is not staged at startup; Config Center no longer offers WeChat or channel setup.

:shared_config_start
set "UCLAW_RUNNING_CORE=%CORE_MODE%"
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
    for /f "usebackq tokens=*" %%p in (`powershell -NoProfile -Command "try { (Get-Content -Raw '%RUNTIME_JSON%' | ConvertFrom-Json).configServerPort } catch {}" 2^>nul`) do set "CONFIG_PORT=%%p"
)
echo   Config Center port: %CONFIG_PORT%

REM Kernel branch: Lite (PicoClaw CLI) skips all OpenClaw-specific steps below.
if "%CORE_MODE%"=="lite" goto :start_lite

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
pause
exit /b 1
:port_selected

REM Publish the chosen port before launching child processes so a second click
REM reuses this exact instance instead of selecting 18790/18791.
if defined UCLAW_LAUNCHER_PID "%NODE_BIN%" "%UCLAW_DIR%lib\portable-instance-lock.mjs" publish "%INSTANCE_ROOT%" "%STATE_DIR%" "%UCLAW_LAUNCHER_PID%" %PORT% >nul 2>&1

REM Single source of truth for the actually-selected gateway port (v2.2.1).
REM config-server and the Config Center page it serves now read this instead of guessing
REM configServerPort + 1 -- see lib/runtime-ports.mjs for why that guess broke
REM on machines where 18789 was already taken by something else.
"%NODE_BIN%" "%UCLAW_DIR%lib\runtime-ports.mjs" publish "%STATE_DIR%" gateway %PORT% >nul 2>&1

echo   Starting OpenClaw on port %PORT%...
echo.

REM Detect whether a model is already configured (issue #24 fix).
REM Old behavior force-opened Config Center on every single launch, even for
REM returning users who had already picked a model -- that's the "every time
REM I start it a config page pops up" complaint. Real intended design (see
REM repo CLAUDE.md): first run (no model configured) opens Config Center;
REM configured runs only open the Dashboard. Config Center is still reachable
REM any time via Windows-Maintain.bat -- this only changes what auto-opens here.
REM Silent-fail helper: any read/parse error is treated as "not configured",
REM so at worst users see one extra Config Center tab, never zero.
set "MODEL_CONFIGURED=0"
for /f "usebackq tokens=1,* delims==" %%a in (`""%NODE_BIN%" "%UCLAW_DIR%lib\check-model-configured.mjs" "%STATE_DIR%\openclaw.json" 2^>nul"`) do (
    if "%%a"=="UCLAW_MODEL_CONFIGURED" set "MODEL_CONFIGURED=%%b"
)

REM Do not open Dashboard before the gateway is ready.
REM Slow USB drives may need tens of seconds to stage bundled deps.
REM Open the local startup page now; Config Center only auto-opens on first run.

REM One browser tab, served by Config Center so readiness can be read same-origin.
REM First run saves the model before gateway initialization; returning users wait for readiness.
echo   Opening startup screen...
set "LOADING_URL=http://127.0.0.1:%CONFIG_PORT%/startup?port=%PORT%&token=uclaw&configured=%MODEL_CONFIGURED%"
if "%MODEL_CONFIGURED%"=="1" goto :open_loading
echo   Select a model and save its API Key in Config Center.
if not defined UCLAW_HEADLESS start "" "http://127.0.0.1:%CONFIG_PORT%/?gatewayPort=%PORT%&start=1"
"%NODE_BIN%" "%UCLAW_DIR%lib\wait-model-config.mjs" "%OPENCLAW_CONFIG_PATH%"
if errorlevel 1 exit /b 1
goto :model_ready
:open_loading
if not defined UCLAW_HEADLESS start "" "%LOADING_URL%"
:model_ready

REM Prewarm gateway in the background after it becomes ready.
start /B "" "%NODE_BIN%" "%UCLAW_DIR%lib\prewarm.mjs" %PORT% uclaw >nul 2>&1

echo.
echo   ========================================
echo   Starting OpenClaw Gateway on port %PORT%...
echo   Model/wallet settings: run Windows-Maintain.bat
echo   First run on a USB drive may take several minutes
echo   (unpacking bundled components). Please wait;
echo   Model configuration is complete. Waiting for Gateway readiness.
echo   DO NOT close this window while using U-Claw!
echo   ========================================
echo.

REM Clean stale gateway lock from a previous crash / USB yank so OpenClaw won't
REM refuse to start with "gateway already running (pid XXXX)". Only locks whose
REM owning process is gone (or corrupt) are removed; a live instance is left alone.
"%NODE_BIN%" "%UCLAW_DIR%lib\clean-stale-lock.mjs" "%OPENCLAW_CONFIG_PATH%"
"%NODE_BIN%" "%UCLAW_DIR%lib\official-provider-guard.mjs" "%OPENCLAW_CONFIG_PATH%" 2>nul

cd /d "%CORE_DIR%"
set "OPENCLAW_MJS=%CORE_DIR%\node_modules\openclaw\openclaw.mjs"
"%NODE_BIN%" "%OPENCLAW_MJS%" gateway run --allow-unconfigured --port %PORT%
set "GW_EXIT=%errorlevel%"

if defined UCLAW_LAUNCHER_PID "%NODE_BIN%" "%UCLAW_DIR%lib\portable-instance-lock.mjs" release "%INSTANCE_ROOT%" "%STATE_DIR%" "%UCLAW_LAUNCHER_PID%" >nul 2>&1

echo.
if not "%GW_EXIT%"=="0" if not "%GW_EXIT%"=="-1073741510" (
    echo   OpenClaw exited unexpectedly ^(code %GW_EXIT%^)
)
echo   OpenClaw stopped.
pause
goto :eof

REM =====================================================================
REM Lite kernel (PicoClaw CLI): fast, lightweight, covers most "ask/write/organize"
REM scenarios. Fully separate from the Full branch above: it does NOT run OpenClaw's
REM loading.html / gateway / prewarm / check-model-configured / wait-model-config /
REM clean-stale-lock / provider-guard. The wallet goes through the same Config Center
REM (already started before this branch); its key is stored in plaintext in
REM data/picoclaw/.security.yml, readable by anyone who can read the USB drive.
:start_lite
echo.
echo   ========================================
echo   U-Claw Lite (PicoClaw)  starting...
echo   ========================================
echo.

set "PICOCLAW_HOME=%DATA_DIR%\picoclaw"
set "PICOCLAW_CONFIG=%PICOCLAW_HOME%\config.json"
set "PICOCLAW_BINARY=%APP_DIR%\picoclaw\picoclaw.exe"
set "PICOCLAW_AGENTS_DEFAULTS_WORKSPACE=%PICOCLAW_HOME%\workspace"
set "PICO_TMP=%PICOCLAW_HOME%\tmp"
if not exist "%PICOCLAW_AGENTS_DEFAULTS_WORKSPACE%" mkdir "%PICOCLAW_AGENTS_DEFAULTS_WORKSPACE%"
if not exist "%PICO_TMP%" mkdir "%PICO_TMP%"

REM Lite publishes no gateway port; duplicate clicks only report the existing CLI.
echo   Lite uses this terminal for chat. There is no Dashboard.
if not exist "%PICOCLAW_BINARY%" (
    echo   [ERROR] PicoClaw is missing. Run setup.bat or choose Full in Config Center.
    if not defined UCLAW_HEADLESS start "" "http://127.0.0.1:%CONFIG_PORT%/"
    goto :lite_failed
)

REM Inspect the effective key, not just security-file existence. No network claim.
set "UCLAW_PICO_WALLET_KEY=0"
for /f "usebackq tokens=1,* delims==" %%a in (`""%NODE_BIN%" "%UCLAW_DIR%lib\picoclaw-config.mjs" has-key "%PICOCLAW_HOME%""`) do (
    if "%%a"=="UCLAW_PICO_WALLET_KEY" set "UCLAW_PICO_WALLET_KEY=%%b"
)
if "%UCLAW_PICO_WALLET_KEY%"=="1" goto :lite_ready
echo   Generate or enable a wallet key in Config Center. Waiting up to 10 minutes.
if not defined UCLAW_HEADLESS start "" "http://127.0.0.1:%CONFIG_PORT%/"
"%NODE_BIN%" "%UCLAW_DIR%lib\wait-picoclaw-key.mjs" "%PICOCLAW_HOME%"
if errorlevel 1 goto :lite_failed
:lite_ready
cd /d "%PICOCLAW_AGENTS_DEFAULTS_WORKSPACE%"
echo   Starting PicoClaw agent. Keep this window open.
REM Portable TEMP/TMP apply only to PicoClaw; all Node helpers keep local temp.
setlocal
set "TEMP=%PICO_TMP%"
set "TMP=%PICO_TMP%"
"%PICOCLAW_BINARY%" agent
endlocal & set "PICO_EXIT=%errorlevel%"
if defined UCLAW_LAUNCHER_PID "%NODE_BIN%" "%UCLAW_DIR%lib\portable-instance-lock.mjs" release "%INSTANCE_ROOT%" "%STATE_DIR%" "%UCLAW_LAUNCHER_PID%" >nul 2>&1
echo   U-Claw Lite stopped with code %PICO_EXIT%.
if not defined UCLAW_HEADLESS pause
exit /b %PICO_EXIT%
:lite_failed
if defined UCLAW_LAUNCHER_PID "%NODE_BIN%" "%UCLAW_DIR%lib\portable-instance-lock.mjs" release "%INSTANCE_ROOT%" "%STATE_DIR%" "%UCLAW_LAUNCHER_PID%" >nul 2>&1
if not defined UCLAW_HEADLESS pause
exit /b 1
