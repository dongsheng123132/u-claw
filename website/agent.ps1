# ============================================================
# M-Claw Remote Agent (Windows)
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
Write-Host "    M-Claw Remote Agent" -ForegroundColor Cyan
Write-Host "  ==========================================" -ForegroundColor Cyan
Write-Host ""

# ---- Safety notice ----
Write-Host "  ! This script will:" -ForegroundColor Yellow
Write-Host "    1. Download a lightweight remote agent (~8MB)" -ForegroundColor DarkGray
Write-Host "    2. Connect to M-Claw relay server" -ForegroundColor DarkGray
Write-Host "    3. Allow remote command execution for support" -ForegroundColor DarkGray
Write-Host "    4. Close this window to disconnect anytime" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  NOTE: Windows Defender / SmartScreen may show a warning" -ForegroundColor Yellow
Write-Host "  because the agent is not code-signed. This is normal." -ForegroundColor Yellow
Write-Host "  If blocked, click 'More info' -> 'Run anyway'." -ForegroundColor Yellow
Write-Host ""
$confirm = Read-Host "  Continue? (y/N)"
if ($confirm -ne "y" -and $confirm -ne "Y") {
    Write-Host "  Cancelled." -ForegroundColor Red
    exit 0
}
Write-Host ""

# ---- Generate Device ID ----
$rand = Get-Random -Minimum 1000 -Maximum 9999
$DEVICE_ID = "pc-$rand"

# ---- Download Agent ----
Write-Host "  [1/2] Downloading agent..." -ForegroundColor White
try {
    if (!(Test-Path $AGENT_DIR)) { New-Item -ItemType Directory -Path $AGENT_DIR -Force | Out-Null }

    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $DOWNLOAD_URL -OutFile $AGENT_PATH -UseBasicParsing -TimeoutSec 120
    $ProgressPreference = 'Continue'

    if (!(Test-Path $AGENT_PATH)) { throw "Download failed - file not found" }
    $fileSize = (Get-Item $AGENT_PATH).Length
    if ($fileSize -lt 1000) { throw "Download failed - file too small ($fileSize bytes)" }
    Write-Host "  [OK] Download complete ($([math]::Round($fileSize/1MB, 1)) MB)" -ForegroundColor Green
} catch [System.Net.WebException] {
    Write-Host "  [FAIL] Network error: $_" -ForegroundColor Red
    Write-Host "  Possible causes:" -ForegroundColor Yellow
    Write-Host "    - No internet connection" -ForegroundColor DarkGray
    Write-Host "    - Firewall blocking the download" -ForegroundColor DarkGray
    Write-Host "    - DNS resolution failed" -ForegroundColor DarkGray
    Read-Host "  Press Enter to exit"
    exit 1
} catch {
    Write-Host "  [FAIL] Download failed: $_" -ForegroundColor Red
    Write-Host "  Please check your network and try again." -ForegroundColor Yellow
    Read-Host "  Press Enter to exit"
    exit 1
}

# Add Windows Defender exclusion hint
try {
    Add-MpPreference -ExclusionPath $AGENT_DIR -ErrorAction SilentlyContinue
} catch {
    # Non-admin users can't add exclusions - that's ok
}
Write-Host "  [TIP] If Defender blocks it: Settings > Virus protection > Allow" -ForegroundColor DarkGray

# ---- Run Agent ----
Write-Host "  [2/2] Connecting..." -ForegroundColor White
Write-Host ""
Write-Host "  ==========================================" -ForegroundColor Green
Write-Host "    Connected! Send this ID to support:" -ForegroundColor Green
Write-Host "  ==========================================" -ForegroundColor Green
Write-Host ""
Write-Host ""
Write-Host "  Device ID:  $DEVICE_ID" -ForegroundColor Green
Write-Host ""
Write-Host "  Hostname:   $env:COMPUTERNAME" -ForegroundColor DarkGray
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
