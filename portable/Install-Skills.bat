@echo off
chcp 65001 >nul 2>&1
title U-Claw - Install Skills from ZIP
powershell -ExecutionPolicy Bypass -File "%~dp0skills-cn\Install-Skills.ps1"
pause
