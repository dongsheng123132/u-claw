@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0lib\open-app.ps1" -Root "%~dp0." -Mode webview
if errorlevel 1 pause
