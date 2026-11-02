@echo off
setlocal
chcp 65001 >nul 2>&1
REM U-Claw Config Center: Xiapan Cloud device wallet, recharge, model keys, channels.
REM Double-click to open it at any time; the launcher starts the backend if needed.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0lib\open-app.ps1" -Mode config -Root "%~dp0."
if errorlevel 1 pause
exit /b %errorlevel%
