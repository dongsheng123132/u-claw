@echo off
REM Clear inherited compatibility settings; enable only for the actual exFAT volume.
set "FS_SAFE_NATIVE_MODE=auto"
set "OPENCLAW_PORTABLE_RENAME_IDENTITY=strict"
set "UCLAW_RUNTIME_OK="
for /f "usebackq tokens=1,* delims==" %%a in (`""%~2" "%~1\lib\runtime-preflight.mjs" "%~1\." --env"`) do (
    if "%%a"=="FS_SAFE_NATIVE_MODE" set "FS_SAFE_NATIVE_MODE=%%b"
    if "%%a"=="OPENCLAW_PORTABLE_RENAME_IDENTITY" set "OPENCLAW_PORTABLE_RENAME_IDENTITY=%%b"
    if "%%a"=="UCLAW_RUNTIME_OK" set "UCLAW_RUNTIME_OK=%%b"
)
if not defined UCLAW_RUNTIME_OK exit /b 1
exit /b 0
