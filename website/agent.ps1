# ============================================================
# U-Claw Remote Agent (Windows)
# Usage: irm https://u-claw.org/agent.ps1 | iex
# ============================================================

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { chcp 65001 | Out-Null } catch {}
Set-ExecutionPolicy Bypass -Scope Process -Force -ErrorAction SilentlyContinue

$RELAY_SERVER = "wss://47.107.130.152:8900"
$DOWNLOAD_URL = "https://u-claw.org/downloads/agent.exe"
$AGENT_DIR = "$env:TEMP\uclaw"
$AGENT_PATH = "$AGENT_DIR\agent.exe"
$TOKEN = "uclaw-agent-pub"
$TIMEOUT_HOURS = 2

Clear-Host
Write-Host ""
Write-Host "  ==========================================" -ForegroundColor Cyan
Write-Host "    U-Claw Remote Agent" -ForegroundColor Cyan
Write-Host "  ==========================================" -ForegroundColor Cyan
Write-Host ""

# ---- Safety notice ----
Write-Host "  ! This script will:" -ForegroundColor Yellow
Write-Host "    1. Download a lightweight remote agent (~8MB)" -ForegroundColor DarkGray
Write-Host "    2. Connect to U-Claw relay server" -ForegroundColor DarkGray
Write-Host "    3. Allow remote command execution for support" -ForegroundColor DarkGray
Write-Host "    4. Close this window to disconnect anytime" -ForegroundColor DarkGray
Write-Host ""
$confirm = Read-Host "  Continue? (y/N)"
if ($confirm -ne "y" -and $confirm -ne "Y") {
    Write-Host "  Cancelled." -ForegroundColor Red
    exit 0
}
Write-Host ""

# ---- Generate Device ID ----
$hostname = $env:COMPUTERNAME.ToLower()
$rand = -join ((97..122) + (48..57) | Get-Random -Count 4 | ForEach-Object { [char]$_ })
$DEVICE_ID = "$hostname-$rand"

# ---- Download Agent ----
Write-Host "  [1/2] Downloading agent..." -ForegroundColor White
try {
    if (!(Test-Path $AGENT_DIR)) { New-Item -ItemType Directory -Path $AGENT_DIR -Force | Out-Null }

    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $DOWNLOAD_URL -OutFile $AGENT_PATH -UseBasicParsing
    $ProgressPreference = 'Continue'

    if (!(Test-Path $AGENT_PATH)) { throw "Download failed" }
    Write-Host "  [OK] Download complete" -ForegroundColor Green
} catch {
    Write-Host "  [FAIL] Download failed: $_" -ForegroundColor Red
    Write-Host "  Please check your network and try again." -ForegroundColor Yellow
    Read-Host "  Press Enter to exit"
    exit 1
}

# ---- Run Agent ----
Write-Host "  [2/2] Connecting..." -ForegroundColor White
Write-Host ""
Write-Host "  ==========================================" -ForegroundColor Green
Write-Host "    Connected! Send this ID to support:" -ForegroundColor Green
Write-Host "  ==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  +------------------------------------------+" -ForegroundColor Cyan
Write-Host "  |  Device ID:  $DEVICE_ID" -ForegroundColor Cyan
Write-Host "  |  Hostname:   $env:COMPUTERNAME" -ForegroundColor Cyan
Write-Host "  +------------------------------------------+" -ForegroundColor Cyan
Write-Host ""
Write-Host "  * Close this window to disconnect" -ForegroundColor DarkGray
Write-Host "  * Auto-disconnect after $TIMEOUT_HOURS hours" -ForegroundColor DarkGray
Write-Host ""

# Run agent with timeout
$agentProcess = Start-Process -FilePath $AGENT_PATH `
    -ArgumentList "-server", $RELAY_SERVER, "-token", $TOKEN, "-id", $DEVICE_ID `
    -NoNewWindow -PassThru

# Auto-timeout
$timeoutMs = $TIMEOUT_HOURS * 3600 * 1000
$sw = [System.Diagnostics.Stopwatch]::StartNew()

try {
    while (!$agentProcess.HasExited) {
        if ($sw.ElapsedMilliseconds -ge $timeoutMs) {
            Write-Host ""
            Write-Host "  [!] Session timed out after $TIMEOUT_HOURS hours" -ForegroundColor Yellow
            $agentProcess.Kill()
            break
        }
        Start-Sleep -Seconds 1
    }
} catch {
    # User closed window or Ctrl+C
} finally {
    if (!$agentProcess.HasExited) {
        try { $agentProcess.Kill() } catch {}
    }
    # Cleanup
    try { Remove-Item -Path $AGENT_DIR -Recurse -Force -ErrorAction SilentlyContinue } catch {}
}

Write-Host ""
Write-Host "  Disconnected. You can close this window." -ForegroundColor Yellow
Read-Host "  Press Enter to exit"
