#Requires -Version 5.1
# open-app.ps1 - open the U-Claw WebUI in a standalone app window.
#
# Edge app mode (default; launched by Windows-App.bat):
#   Wait for the gateway (reusing data/.openclaw/runtime.json's real gatewayPort
#   when it is already live), then open Microsoft Edge with
#   --app=<loopback dashboard URL> and a per-USB user-data-dir on the host disk.
#
# Config mode (-Mode config; consumed by Windows-Config.bat and the menu's
# "Xiapan Cloud wallet and model settings" entry): open U-Claw's own Config Center
# (config-server) - the only page with the Xiapan Cloud device wallet, recharge and
# model key pickers.
#
# WebView mode (-Mode webview; consumed by Windows-WebView.bat):
#   Same readiness gate, then launch app/shell/U-Claw-Shell.exe (the shell is
#   built separately). Contract (shell/main_windows.go):
#     U-Claw-Shell.exe <loopbackUrl> <hostCacheDirectory>
#
# Rules (shared with the rest of lib/):
#   - No backend changes and no auto-downloads.
#   - The gateway port comes from runtime.json, never guessed.
#   - /ready is validated as JSON, not "any HTTP 200" (a random local web server
#     that answers every path with HTML must not be mistaken for the gateway).
#   - The browser profile stays off the USB drive (host LOCALAPPDATA only).

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('edge', 'webview', 'config')]
    [string]$Mode = 'edge',

    # Optional absolute root (Windows-WebView.bat passes "%~dp0."). When omitted,
    # the root is derived from this script's own location under lib/.
    [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

# Headless regardless of how this script was invoked: Windows-Start.bat must not
# open its own loading page/browser while we wait for the gateway.
$env:UCLAW_HEADLESS = '1'

if ($Root) {
    $UclawRoot = [IO.Path]::GetFullPath($Root)
} else {
    $UclawRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
}
$StateDir = Join-Path $UclawRoot 'data\.openclaw'
$RuntimeJson = Join-Path $StateDir 'runtime.json'
$StartBat = Join-Path $UclawRoot 'Windows-Start.bat'

# Seconds to wait for the gateway after starting Windows-Start.bat. Slow USB
# first runs may need tens of seconds; the wait is bounded so a broken start can
# never hang this launcher forever.
$ReadyTimeoutSeconds = 90

function Get-GatewayPortFromRuntime {
    # Read the launcher's source of truth. A missing/corrupt runtime.json yields
    # $null instead of a guess (guessing wrong is worse than not guessing).
    if (-not (Test-Path -LiteralPath $RuntimeJson -PathType Leaf)) { return $null }
    try {
        $runtime = Get-Content -LiteralPath $RuntimeJson -Raw | ConvertFrom-Json
        $port = [int]$runtime.gatewayPort
        if ($port -gt 0 -and $port -le 65535) { return $port }
    } catch {
        return $null
    }
    return $null
}

function Get-ConfigPortFromRuntime {
    # The Config Center (config-server) publishes configServerPort in the same
    # runtime.json. Missing/corrupt yields $null - never guess a port.
    if (-not (Test-Path -LiteralPath $RuntimeJson -PathType Leaf)) { return $null }
    try {
        $runtime = Get-Content -LiteralPath $RuntimeJson -Raw | ConvertFrom-Json
        $port = [int]$runtime.configServerPort
        if ($port -gt 0 -and $port -le 65535) { return $port }
    } catch {
        return $null
    }
    return $null
}

function Test-ModelConfigured {
    # Single source of truth: lib/check-model-configured.mjs - the same helper the
    # .bat era used to decide "first run". Runs on the bundled runtime only.
    $NodeBin = Join-Path $UclawRoot 'app\runtime\node-win-x64\node.exe'
    $Checker = Join-Path $UclawRoot 'lib\check-model-configured.mjs'
    if (-not (Test-Path -LiteralPath $NodeBin -PathType Leaf)) { return $false }
    if (-not (Test-Path -LiteralPath $Checker -PathType Leaf)) { return $false }
    try {
        $lines = & $NodeBin $Checker (Join-Path $StateDir 'openclaw.json') 2>$null
    } catch {
        return $false
    }
    foreach ($line in @($lines)) {
        if ([string]$line -eq 'UCLAW_MODEL_CONFIGURED=1') { return $true }
    }
    return $false
}

function Test-GatewayReady {
    param([int]$Port)
    if ($Port -le 0) { return $false }
    try {
        $body = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/ready" -TimeoutSec 2 -ErrorAction Stop
    } catch {
        return $false
    }
    if ($null -eq $body) { return $false }
    # A real OpenClaw /ready is shaped like:
    #   { ready: boolean, failing: array, uptimeMs: number, eventLoop: object }
    # Require all of it so a service that answers any path with HTML is rejected.
    $readyIsBool = ($null -ne $body.ready) -and ($body.ready -is [bool])
    $failingIsArray = ($null -ne $body.failing) -and ($body.failing -is [System.Array])
    $uptimeIsNumber = ($null -ne $body.uptimeMs) -and ($body.uptimeMs -is [int] -or $body.uptimeMs -is [long] -or $body.uptimeMs -is [double] -or $body.uptimeMs -is [decimal])
    $eventLoopIsObject = ($null -ne $body.eventLoop) -and ($body.eventLoop -isnot [string]) -and ($body.eventLoop -isnot [System.Array])
    return ($readyIsBool -and $failingIsArray -and $uptimeIsNumber -and $eventLoopIsObject)
}

function Get-SlotFromRoot {
    param([string]$AbsoluteRoot)
    # Stable slot from the absolute USB root path (normalized + lower-cased) so
    # the same stick keeps one host profile, and different sticks never collide.
    $normalized = ([IO.Path]::GetFullPath($AbsoluteRoot)).TrimEnd('\').ToLowerInvariant()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($normalized)
        $hash = $sha.ComputeHash($bytes)
        $hex = -join ($hash | ForEach-Object { $_.ToString('x2') })
        return $hex.Substring(0, 16)
    } finally {
        $sha.Dispose()
    }
}

function Get-LocalAppData {
    if ($env:LOCALAPPDATA) { return $env:LOCALAPPDATA }
    if ($env:USERPROFILE) { return (Join-Path $env:USERPROFILE 'AppData\Local') }
    return $null
}

function Get-EdgePath {
    $candidates = @()
    if ($env:ProgramFiles) {
        $candidates += (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
    }
    if (${env:ProgramFiles(x86)}) {
        $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
    }
    if ($env:LOCALAPPDATA) {
        $candidates += (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Quote-CliArg {
    param([string]$Value)
    # Quoted for CreateProcess (not cmd.exe), so '&' is data, not a command
    # separator; only values containing spaces/ampersands need surrounding quotes.
    if ($Value -match '[\s&]') {
        return '"' + $Value + '"'
    }
    return $Value
}

function Start-NativeProcess {
    param(
        [string]$FileName,
        [string]$Arguments,
        [string]$WorkingDirectory
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FileName
    $psi.Arguments = $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $false
    if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
    [void][System.Diagnostics.Process]::Start($psi)
}

function Start-WindowsStartBat {
    # Bring the gateway up through the untouched Windows-Start.bat, in its own
    # console window, and return immediately. cmd /c ""path"" survives spaces
    # and '&' in the USB folder name.
    $arguments = '/c ""' + $StartBat + '""'
    Start-NativeProcess 'cmd.exe' $arguments $UclawRoot
}

$LocalAppData = Get-LocalAppData
if (-not $LocalAppData) {
    # Never fall back to the USB drive for the browser profile; use host temp.
    $LocalAppData = Join-Path ([IO.Path]::GetTempPath()) 'U-Claw'
}
$Slot = Get-SlotFromRoot $UclawRoot
$CacheRoot = Join-Path (Join-Path $LocalAppData 'U-Claw') $Slot
$ProfileName = 'edge-app'
if ($Mode -eq 'webview') { $ProfileName = 'webview' }
$UserDataDir = Join-Path $CacheRoot $ProfileName
try {
    New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
} catch {
    # Host profile dir unwritable: keep going; the browser may still create it,
    # and the default-browser fallback below works either way.
}

$Url = $null
$Port = Get-GatewayPortFromRuntime
if ($Port -and (Test-GatewayReady $Port)) {
    $Url = "http://127.0.0.1:$Port/#token=uclaw"
}

if (-not $Url) {
    # Gateway not live yet: start the normal launcher (headless) and wait a
    # bounded time for runtime.json + /ready.
    Start-WindowsStartBat
    $Deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $Deadline) {
        Start-Sleep -Seconds 1
        $Port = Get-GatewayPortFromRuntime
        if ($Port -and (Test-GatewayReady $Port)) {
            $Url = "http://127.0.0.1:$Port/#token=uclaw"
            break
        }
    }
}

if (-not $Url) {
    Write-Warning "U-Claw gateway did not become ready within $ReadyTimeoutSeconds seconds."
    exit 2
}

# First run / unconfigured: U-Claw's own Config Center is the only page that hosts
# the Xiapan Cloud device wallet (claim / recharge / rotate) and the model key
# pickers. The Gateway dashboard lists upstream OpenClaw providers instead, so a
# launcher that opens the dashboard first leaves the user with no wallet entry
# (v2.3.8 shell regression). ?embed=1 keeps the hand-off to the dashboard inside
# the same window, because the standalone shell has no tab strip.
$ConfigFirst = ($Mode -eq 'config') -or (-not (Test-ModelConfigured))
if ($ConfigFirst) {
    $ConfigPort = Get-ConfigPortFromRuntime
    if ($ConfigPort) {
        $Url = "http://127.0.0.1:$ConfigPort/?embed=1"
    } else {
        # Never open a dead page: keep the dashboard when the port is unknown.
        Write-Warning 'Config Center port unknown; opening the dashboard instead.'
    }
}

if ($Mode -eq 'webview') {
    $ShellExe = Join-Path $UclawRoot 'app\shell\U-Claw-Shell.exe'
    if (Test-Path -LiteralPath $ShellExe -PathType Leaf) {
        # shell/main_windows.go takes two positional args: url then host cache dir.
        $shellArgs = (Quote-CliArg $Url) + ' ' + (Quote-CliArg $UserDataDir)
        Start-NativeProcess $ShellExe $shellArgs $UclawRoot
    } else {
        # Shell not present yet: fall back to the default browser, never fail.
        Start-Process -FilePath $Url
    }
} elseif ($Mode -eq 'config') {
    # Config Center in the default browser: a normal tab keeps window.open() working
    # after the wallet is claimed and the dashboard link is clicked.
    Start-Process -FilePath $Url
} else {
    $EdgePath = Get-EdgePath
    if ($EdgePath) {
        $edgeArgs = '--app=' + (Quote-CliArg $Url) + ' --user-data-dir=' + (Quote-CliArg $UserDataDir) + ' --no-first-run --no-default-browser-check'
        Start-NativeProcess $EdgePath $edgeArgs $UclawRoot
    } else {
        # No Edge found: open the default browser instead.
        Start-Process -FilePath $Url
    }
}

exit 0
