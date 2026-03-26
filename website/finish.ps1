# M-Claw 快速完成安装（Node已装好，只需下载bundle+配置）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Continue"

$UCLAW = "$env:USERPROFILE\.uclaw"
$NODE = "$UCLAW\runtime\node-win-x64\node.exe"
$CORE = "$UCLAW\core"
$DATA = "$UCLAW\data"

# 确保目录存在
@("$UCLAW\runtime","$CORE","$DATA\.openclaw","$DATA\memory","$DATA\backups") | ForEach-Object {
    New-Item -ItemType Directory -Force -Path $_ -ErrorAction SilentlyContinue | Out-Null
}

# Step 1: Node
if (-not (Test-Path $NODE)) {
    Write-Host "下载 Node.js..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri "https://npmmirror.com/mirrors/node/v22.14.0/node-v22.16.0-win-x64.zip" -OutFile "$env:TEMP\node.zip" -UseBasicParsing
    Expand-Archive "$env:TEMP\node.zip" "$env:TEMP\node-ext" -Force
    Move-Item "$env:TEMP\node-ext\node-v22.16.0-win-x64" "$UCLAW\runtime\node-win-x64" -Force
    Remove-Item "$env:TEMP\node.zip","$env:TEMP\node-ext" -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "[OK] Node: $(& $NODE --version)"

# Step 2: OpenClaw bundle
if (-not (Test-Path "$CORE\node_modules\openclaw\openclaw.mjs")) {
    Write-Host "下载 OpenClaw..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    $url = "https://ghfast.top/https://github.com/dongsheng123132/u-claw/releases/download/v1.0.0-bundle/openclaw-bundle.zip"
    Invoke-WebRequest -Uri $url -OutFile "$env:TEMP\oc.zip" -UseBasicParsing -TimeoutSec 300
    Write-Host "解压中..."
    Expand-Archive "$env:TEMP\oc.zip" "$CORE" -Force
    Remove-Item "$env:TEMP\oc.zip" -Force -ErrorAction SilentlyContinue
}
Write-Host "[OK] OpenClaw: $(Test-Path "$CORE\node_modules\openclaw\openclaw.mjs")"

# Step 3: 默认配置 (DeepSeek)
$cfg = "$DATA\.openclaw\openclaw.json"
if (-not (Test-Path $cfg)) {
    $json = '{"gateway":{"mode":"local","auth":{"token":"uclaw"}}}'
    [IO.File]::WriteAllText($cfg, $json, (New-Object System.Text.UTF8Encoding $false))
}
Write-Host "[OK] Config"

# Step 4: 启动脚本
$bat = @"
@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title M-Claw
set "DIR=%~dp0"
set "NODE_BIN=%DIR%runtime\node-win-x64\node.exe"
if not exist "%NODE_BIN%" set "NODE_BIN=node"
set "OPENCLAW_MJS=%DIR%core\node_modules\openclaw\openclaw.mjs"
set "OPENCLAW_HOME=%DIR%data"
set "OPENCLAW_STATE_DIR=%DIR%data\.openclaw"
set "OPENCLAW_CONFIG_PATH=%DIR%data\.openclaw\openclaw.json"
set PORT=18789
:check_port
netstat -an | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (set /a PORT+=1 & if !PORT! gtr 18799 (echo No port & pause & exit /b 1) & goto :check_port)
cd /d "%DIR%core"
start /B "" cmd /c "timeout /t 3 /nobreak >nul && start http://127.0.0.1:!PORT!/#token=uclaw"
"%NODE_BIN%" "%OPENCLAW_MJS%" gateway run --allow-unconfigured --force --port !PORT!
pause
"@
[IO.File]::WriteAllText("$UCLAW\start.bat", $bat, (New-Object System.Text.ASCIIEncoding))
Write-Host "[OK] start.bat"

# Step 5: 验证
Write-Host ""
Write-Host "===== 安装完成 ====="
Write-Host "Node: $(& $NODE --version)"
Write-Host "OpenClaw: $(if(Test-Path "$CORE\node_modules\openclaw\openclaw.mjs"){'OK'}else{'FAIL'})"
Write-Host "启动: 双击 $UCLAW\start.bat"
Write-Host "====="
