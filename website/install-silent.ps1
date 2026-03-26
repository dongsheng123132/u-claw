# ============================================================
# M-Claw Silent Installer (Windows PowerShell)
# Non-interactive version for remote exec deployment
#
# Usage:
#   install-silent.ps1 -Model deepseek-chat -ApiKey sk-xxx
#   install-silent.ps1 -Model deepseek-chat -ApiKey sk-xxx -BaseUrl https://api.deepseek.com/v1
#   install-silent.ps1 -Model ollama -NoKey
#   install-silent.ps1 -SkipConfig   # install only, configure later
# ============================================================
param(
    [string]$Model = "deepseek-chat",
    [string]$ApiKey = "",
    [string]$BaseUrl = "",
    [switch]$NoKey,
    [switch]$SkipConfig,
    [switch]$Force
)

Set-ExecutionPolicy Bypass -Scope Process -Force -ErrorAction SilentlyContinue
try {
    $null = cmd /c chcp 65001
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

$ErrorActionPreference = "Stop"

# ---- Constants ----
$UCLAW_DIR = "$env:USERPROFILE\.uclaw"
$RUNTIME_DIR = "$UCLAW_DIR\runtime"
$CORE_DIR = "$UCLAW_DIR\core"
$DATA_DIR = "$UCLAW_DIR\data"
$CONFIG_PATH = "$DATA_DIR\.openclaw\openclaw.json"
$NODE_VERSION = "v22.16.0"
$NODE_MIRROR = "https://npmmirror.com/mirrors/node"

# ---- Known model presets ----
$presets = @{
    "deepseek-chat"    = @{ baseUrl="https://api.deepseek.com/v1"; provider="custom" }
    "moonshot-v1-auto" = @{ baseUrl="https://api.moonshot.cn/v1"; provider="custom" }
    "qwen-plus"        = @{ baseUrl="https://dashscope.aliyuncs.com/compatible-mode/v1"; provider="custom" }
    "glm-4-plus"       = @{ baseUrl="https://open.bigmodel.cn/api/paas/v4"; provider="custom" }
    "abab6.5s-chat"    = @{ baseUrl="https://api.minimax.chat/v1"; provider="custom" }
    "claude-sonnet-4-20250514" = @{ baseUrl=""; provider="anthropic" }
    "gpt-4o"           = @{ baseUrl=""; provider="openai" }
    "ollama"           = @{ baseUrl="http://127.0.0.1:11434/v1"; provider="custom"; model="llama3.2" }
}

function Log($msg) { Write-Host "[uclaw-silent] $msg" }
function LogOK($msg) { Write-Host "[uclaw-silent] OK: $msg" -ForegroundColor Green }
function LogFail($msg) { Write-Host "[uclaw-silent] FAIL: $msg" -ForegroundColor Red }

# ============================================================
# Check existing install
# ============================================================
if ((Test-Path "$CORE_DIR\node_modules\openclaw") -and -not $Force) {
    LogOK "Already installed at $UCLAW_DIR. Use -Force to overwrite."
    exit 0
}

# Create directories
foreach ($d in @($RUNTIME_DIR, $CORE_DIR, "$DATA_DIR\.openclaw", "$DATA_DIR\memory", "$DATA_DIR\backups")) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}

# ============================================================
# Step 1: Node.js
# ============================================================
Log "Installing Node.js $NODE_VERSION ..."

$ARCH = $env:PROCESSOR_ARCHITECTURE
if ($ARCH -eq "AMD64" -or $ARCH -eq "x86_64") { $PLATFORM = "win-x64" }
elseif ($ARCH -eq "ARM64") { $PLATFORM = "win-arm64" }
else { LogFail "Unsupported arch: $ARCH"; exit 1 }

$NODE_INSTALL_DIR = "$RUNTIME_DIR\node-$PLATFORM"
$INSTALL_NODE = ""
$NPM_CLI = ""

# Check system Node.js
$sysNode = Get-Command node -ErrorAction SilentlyContinue
if ($sysNode) {
    $sysVer = & node --version 2>$null
    $major = [int]($sysVer -replace 'v','').Split('.')[0]
    if ($major -ge 20) {
        LogOK "System Node.js $sysVer"
        $INSTALL_NODE = "node"
    }
}

if (-not $INSTALL_NODE) {
    if (Test-Path "$NODE_INSTALL_DIR\node.exe") {
        LogOK "Node.js already downloaded"
        $INSTALL_NODE = "$NODE_INSTALL_DIR\node.exe"
    } else {
        $zipName = "node-$NODE_VERSION-$PLATFORM.zip"
        $url = "$NODE_MIRROR/$NODE_VERSION/$zipName"
        $tempZip = "$env:TEMP\$zipName"
        $tempExtract = "$env:TEMP\node-extract-uclaw"

        Log "Downloading $url ..."
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue'
        try {
            Invoke-WebRequest -Uri $url -OutFile $tempZip -UseBasicParsing
        } catch {
            try { & curl.exe -sL $url -o $tempZip } catch { LogFail "Node.js download failed"; exit 1 }
        }

        if (Test-Path $tempExtract) { Remove-Item -Recurse -Force $tempExtract }
        Expand-Archive -Path $tempZip -DestinationPath $tempExtract -Force
        $extractedDir = Get-ChildItem $tempExtract | Select-Object -First 1
        New-Item -ItemType Directory -Force -Path $NODE_INSTALL_DIR | Out-Null
        Copy-Item -Recurse -Force "$($extractedDir.FullName)\*" $NODE_INSTALL_DIR
        Remove-Item -Force $tempZip -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force $tempExtract -ErrorAction SilentlyContinue

        if (Test-Path "$NODE_INSTALL_DIR\node.exe") {
            LogOK "Node.js installed"
            $INSTALL_NODE = "$NODE_INSTALL_DIR\node.exe"
        } else {
            LogFail "Node.js install failed"; exit 1
        }
    }
    $env:PATH = "$NODE_INSTALL_DIR;$env:PATH"
}

# ============================================================
# Step 2: OpenClaw bundle
# ============================================================
Log "Installing OpenClaw ..."

if (Test-Path "$CORE_DIR\node_modules\openclaw\openclaw.mjs") {
    LogOK "OpenClaw already installed"
} else {
    $BUNDLE_URL = "https://github.com/dongsheng123132/u-claw/releases/download/v1.0.0-bundle/openclaw-bundle.zip"
    $BUNDLE_MIRRORS = @(
        "https://ghfast.top/$BUNDLE_URL",
        "https://gh-proxy.com/$BUNDLE_URL",
        "https://mirror.ghproxy.com/$BUNDLE_URL",
        $BUNDLE_URL
    )
    $bundleZip = "$env:TEMP\openclaw-bundle.zip"
    $downloaded = $false

    foreach ($mirrorUrl in $BUNDLE_MIRRORS) {
        Log "Trying: $mirrorUrl"
        try {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $mirrorUrl -OutFile $bundleZip -UseBasicParsing -TimeoutSec 60
            if ((Get-Item $bundleZip).Length -gt 1MB) { $downloaded = $true; break }
        } catch {}
    }

    if (-not $downloaded) {
        try {
            & curl.exe -sL "https://ghfast.top/$BUNDLE_URL" -o $bundleZip
            if ((Get-Item $bundleZip).Length -gt 1MB) { $downloaded = $true }
        } catch {}
    }

    if (-not $downloaded) { LogFail "OpenClaw download failed"; exit 1 }

    $tempExtract = "$env:TEMP\openclaw-bundle-extract"
    if (Test-Path $tempExtract) { Remove-Item -Recurse -Force $tempExtract }
    Expand-Archive -Path $bundleZip -DestinationPath $tempExtract -Force
    New-Item -ItemType Directory -Force -Path $CORE_DIR | Out-Null
    Copy-Item -Recurse -Force "$tempExtract\*" $CORE_DIR
    Remove-Item -Force $bundleZip -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $tempExtract -ErrorAction SilentlyContinue

    if (Test-Path "$CORE_DIR\node_modules\openclaw\openclaw.mjs") {
        LogOK "OpenClaw installed"
    } else {
        LogFail "OpenClaw install failed"; exit 1
    }
}

# ============================================================
# Step 3: Config
# ============================================================
if ($SkipConfig) {
    Log "Skipping config (-SkipConfig)"
} else {
    Log "Configuring model: $Model ..."

    # Resolve model preset
    $resolvedModel = $Model
    $resolvedBaseUrl = $BaseUrl
    $resolvedProvider = "custom"

    if ($presets.ContainsKey($Model)) {
        $p = $presets[$Model]
        if ($p.model) { $resolvedModel = $p.model }
        if (-not $resolvedBaseUrl -and $p.baseUrl) { $resolvedBaseUrl = $p.baseUrl }
        $resolvedProvider = $p.provider
    }

    if ($resolvedProvider -eq "custom" -and $resolvedBaseUrl) {
        $configJson = @"
{
  "gateway": {
    "mode": "local",
    "auth": { "token": "uclaw" }
  },
  "agent": {
    "model": "$resolvedModel",
    "apiKey": "$ApiKey",
    "baseUrl": "$resolvedBaseUrl"
  }
}
"@
    } else {
        $configJson = @"
{
  "gateway": {
    "mode": "local",
    "auth": { "token": "uclaw" }
  },
  "agent": {
    "model": "$resolvedModel",
    "apiKey": "$ApiKey",
    "provider": "$resolvedProvider"
  }
}
"@
    }

    [IO.File]::WriteAllText($CONFIG_PATH, $configJson, (New-Object System.Text.UTF8Encoding $false))
    LogOK "Config saved: model=$resolvedModel"
}

# ============================================================
# Step 4: Generate start script
# ============================================================
Log "Generating start.bat ..."

$startBat = @'
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
if %errorlevel%==0 (
    set /a PORT+=1
    if !PORT! gtr 18799 (echo No available port & pause & exit /b 1)
    goto :check_port
)

cd /d "%DIR%core"
start /B "" cmd /c "timeout /t 3 /nobreak >nul && start http://127.0.0.1:!PORT!/#token=uclaw"
"%NODE_BIN%" "%OPENCLAW_MJS%" gateway run --allow-unconfigured --force --port !PORT!
pause
'@

$startBat | Out-File -Encoding ascii "$UCLAW_DIR\start.bat"
LogOK "start.bat generated"

# ============================================================
# Done
# ============================================================
Log ""
LogOK "Installation complete!"
Log "  Location: $UCLAW_DIR"
Log "  Start:    $UCLAW_DIR\start.bat"
