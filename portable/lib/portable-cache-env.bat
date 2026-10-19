@echo off
REM portable-cache-env.bat - portable-cache.mjs call layer (single cache resolver).
REM usage: call portable-cache-env.bat STATE_DIR USB_ROOT [NODE_BIN]
REM   NODE_BIN defaults to %NODE_BIN%, then the portable app runtime.
REM success (exit 0): exports NODE_COMPILE_CACHE, npm_config_cache, TEMP, TMP, TMPDIR,
REM   SQLITE_TMPDIR, OPENCLAW_MANAGED_BROWSER_DIR, UCLAW_CACHE_ROOT, UCLAW_LOG_DIR,
REM   UCLAW_TEMP_DIR into the CALLING cmd process; clears NODE_DISABLE_COMPILE_CACHE.
REM failure (exit 1, no writable local cache): clears the cache variables above,
REM   sets NODE_DISABLE_COMPILE_CACHE=1, prints an error to stderr, exit /b 1.
REM The caller must NOT swallow this stderr (no nul-redirect around this call).
REM ASCII-only: cmd.exe reads .bat as GBK on Chinese Windows; keep non-ASCII out.
setlocal EnableExtensions DisableDelayedExpansion

set "_PC_STATE=%~1"
set "_PC_USB=%~2"
set "_PC_NODE=%~3"
if not defined _PC_NODE set "_PC_NODE=%NODE_BIN%"
if not defined _PC_NODE set "_PC_NODE=%~dp0..\app\runtime\node-win-x64\node.exe"

set "_PC_AVAIL="
set "_PC_ROOT="
set "_PC_COMPILE="
set "_PC_NPM="
set "_PC_TMP="
set "_PC_LOG="
set "_PC_BROWSER="

if not defined _PC_STATE goto :fail
if not defined _PC_USB set "_PC_USB=%~dp0.."
if not exist "%_PC_NODE%" (
    echo   [ERROR] Node runtime not found: %_PC_NODE% 1>&2
    goto :fail
)

REM node stderr is intentionally NOT redirected here: it flows to this console.
REM Values are carried only via quoted set - never eval, never echoed raw.
for /f "usebackq tokens=1,* delims==" %%a in (`""%_PC_NODE%" "%~dp0portable-cache.mjs" "%_PC_STATE%" "%_PC_USB%""`) do (
    if "%%a"=="UCLAW_CACHE_ROOT" (set "_PC_ROOT=%%b") else if "%%a"=="UCLAW_COMPILE_CACHE_DIR" (set "_PC_COMPILE=%%b") else if "%%a"=="UCLAW_NPM_CACHE_DIR" (set "_PC_NPM=%%b") else if "%%a"=="UCLAW_TEMP_DIR" (set "_PC_TMP=%%b") else if "%%a"=="UCLAW_LOG_DIR" (set "_PC_LOG=%%b") else if "%%a"=="UCLAW_MANAGED_BROWSER_DIR" (set "_PC_BROWSER=%%b") else if "%%a"=="UCLAW_LOCAL_CACHE_AVAILABLE" set "_PC_AVAIL=%%b"
)

if "%_PC_AVAIL%"=="1" goto :ok
goto :fail

:fail
echo   [ERROR] No writable local cache directory on this PC. 1>&2
echo   Refusing to write cache to the portable drive. 1>&2
endlocal & set "NODE_COMPILE_CACHE=" & set "npm_config_cache=" & set "OPENCLAW_MANAGED_BROWSER_DIR=" & set "UCLAW_CACHE_ROOT=" & set "UCLAW_LOG_DIR=" & set "UCLAW_TEMP_DIR=" & set "NODE_DISABLE_COMPILE_CACHE=1" & exit /b 1

:ok
endlocal & set "NODE_COMPILE_CACHE=%_PC_COMPILE%" & set "npm_config_cache=%_PC_NPM%" & set "TEMP=%_PC_TMP%" & set "TMP=%_PC_TMP%" & set "TMPDIR=%_PC_TMP%" & set "SQLITE_TMPDIR=%_PC_TMP%" & set "OPENCLAW_MANAGED_BROWSER_DIR=%_PC_BROWSER%" & set "UCLAW_CACHE_ROOT=%_PC_ROOT%" & set "UCLAW_LOG_DIR=%_PC_LOG%" & set "UCLAW_TEMP_DIR=%_PC_TMP%" & set "NODE_DISABLE_COMPILE_CACHE=" & exit /b 0
