# win-accept.ps1 - U-Claw v2.5 engine-on-host acceptance on a real Windows machine.
#
# What it does (no repo checkout required):
#   1. gets a source runtime (an already installed app/ tree, or the latest release zip)
#   2. packs it the way CI will: engine-<OPENCLAW_VERSION>.tar.gz + .sha256 sidecar
#   3. stages the repo skeleton (from the main branch tarball) on a scratch root
#   4. runs the acceptance cases and writes a machine-readable summary
#
# Cases:
#   A cold-first-run   host install + first boot (recorded install seconds and ready seconds)
#   B warm-second-run  reuse, no reinstall, recorded ready seconds
#   C forced-drive     UCLAW_ENGINE_MODE=drive, engine on the scratch root
#   D corrupt-archive  wrong .sha256 must fail cleanly and leave no half-installed engine
#   E interrupted      kill the installer mid-extract, rerun must recover
#   F legacy           no engine archive -> the old loose tree keeps working
#
# Usage (as admin-free as possible):
#   powershell -NoProfile -ExecutionPolicy Bypass -File win-accept.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File win-accept.ps1 -Root G:\uclaw-accept
#
# Result: <Root>\accept-summary.json and <Root>\accept.log

[CmdletBinding()]
param(
    [string]$Root = "D:\uclaw-accept",
    [string]$SourceApp = "",
    [string]$RepoRef = "main"
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$logPath = Join-Path $Root 'accept.log'
$summaryPath = Join-Path $Root 'accept-summary.json'
$Version = ''

function Log([string]$m) {
    $line = '[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $m
    Write-Host $line
    try { Add-Content -Path $logPath -Value $line -Encoding UTF8 } catch { }
}

function Fail([string]$m) { Log ('FATAL: ' + $m); exit 1 }

New-Item -ItemType Directory -Force -Path $Root | Out-Null
Set-Content -Path $logPath -Value ('=== uclaw win acceptance ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8
$results = [ordered]@{}
$script:failures = 0

function Record([string]$name, [hashtable]$data) {
    $results[$name] = $data
    $status = if ($data.ok) { 'PASS' } else { 'FAIL'; }
    if (-not $data.ok) { $script:failures++ }
    Log ("CASE $name -> " + $status + " " + ($data | ConvertTo-Json -Compress))
}

function Wait-Ready([int]$port, [int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            if ((Invoke-WebRequest -Uri "http://127.0.0.1:$port/ready" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { return $true }
        } catch { }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Stop-Gateways {
    Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine -like '*openclaw*' } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { } }
    Start-Sleep -Seconds 4
}

# ---------------------------------------------------------------- source runtime
Log '--- locating a source runtime (app/ tree with node + openclaw) ---'
$candidates = @()
if ($SourceApp) { $candidates += $SourceApp }
$candidates += @('D:\p0-skel', 'C:\uclaw-src', (Join-Path $Root 'src'))
$srcRoot = $null
foreach ($c in $candidates) {
    if ($c -and (Test-Path (Join-Path $c 'app\core\node_modules\openclaw\openclaw.mjs'))) { $srcRoot = $c; break }
}
if (-not $srcRoot) {
    Log 'no local runtime found; downloading the latest release zip as the engine source'
    $zip = Join-Path $Root 'source.zip'
    if (-not (Test-Path $zip)) {
        $urls = @(
            'https://github.com/dongsheng123132/u-claw/releases/latest/download/u-claw-portable-windows-v2.4.3.zip',
            'https://gh-proxy.com/https://github.com/dongsheng123132/u-claw/releases/latest/download/u-claw-portable-windows-v2.4.3.zip'
        )
        foreach ($url in $urls) {
            Log ('download ' + $url)
            & curl.exe -sL --max-time 1800 -o $zip $url
            if ((Test-Path $zip) -and ((Get-Item $zip).Length -gt 50MB)) { break }
            Remove-Item $zip -Force -ErrorAction SilentlyContinue
        }
        if (-not (Test-Path $zip)) { Fail 'release zip download failed' }
    }
    Log ('zip ' + [math]::Round((Get-Item $zip).Length / 1MB, 0) + ' MB')
    $extract = Join-Path $Root 'src'
    New-Item -ItemType Directory -Force -Path $extract | Out-Null
    & tar.exe -xf $zip -C $extract
    $srcRoot = (Get-ChildItem $extract -Directory | Select-Object -First 1).FullName
}
$Version = (Get-Content (Join-Path $srcRoot 'OPENCLAW_VERSION') -Raw).Trim()
Log ('source=' + $srcRoot + ' openclaw=' + $Version)
if (-not $Version) { Fail 'OPENCLAW_VERSION missing in the source runtime' }

# ---------------------------------------------------------------- repo skeleton
$skelDir = Join-Path $Root 'skeleton'
if (-not (Test-Path (Join-Path $skelDir 'lib\engine-host.ps1'))) {
    Log '--- fetching the repo skeleton from the main branch ---'
    $tgz = Join-Path $Root 'repo.tar.gz'
    $skelUrls = @(
        ('https://codeload.github.com/dongsheng123132/u-claw/tar.gz/refs/heads/' + $RepoRef),
        ('https://gh-proxy.com/https://github.com/dongsheng123132/u-claw/archive/refs/heads/' + $RepoRef + '.tar.gz')
    )
    foreach ($u in $skelUrls) {
        Log ('skeleton ' + $u)
        & curl.exe -sL --max-time 600 -o $tgz $u
        if ((Test-Path $tgz) -and ((Get-Item $tgz).Length -gt 100KB)) { break }
        Remove-Item $tgz -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path $tgz)) { Fail 'skeleton download failed' }
    $tmp = Join-Path $Root 'repo-extract'
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    & tar.exe -xzf $tgz -C $tmp
    $inner = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
    New-Item -ItemType Directory -Force -Path $skelDir | Out-Null
    & robocopy (Join-Path $inner 'portable') $skelDir /E /XD app data /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
}
if (-not (Test-Path (Join-Path $skelDir 'lib\engine-host.ps1'))) { Fail 'skeleton is missing lib\engine-host.ps1' }
Log ('skeleton=' + $skelDir)

# ---------------------------------------------------------------- pack the engine
$stick = Join-Path $Root 'stick'
New-Item -ItemType Directory -Force -Path $stick | Out-Null
& robocopy $skelDir $stick /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
Copy-Item (Join-Path $skelDir 'OPENCLAW_VERSION') (Join-Path $stick 'OPENCLAW_VERSION') -Force
$archive = Join-Path $stick ('engine-' + $Version + '.tar.gz')
if (-not (Test-Path $archive)) {
    Log '--- packing engine archive (this is what CI will ship) ---'
    $t0 = Get-Date
    Push-Location $srcRoot
    & tar.exe --exclude='app/.npm-cache' -czf $archive app extensions 2>$null
    Pop-Location
    Log ('pack ' + [int]((Get-Date) - $t0).TotalSeconds + 's size=' + [math]::Round((Get-Item $archive).Length / 1MB, 1) + 'MB')
}
if (-not (Test-Path $archive)) { Fail 'engine archive was not created' }
$sha = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -Path ($archive + '.sha256') -Value $sha -NoNewline -Encoding ASCII
Log ('archive ' + [math]::Round((Get-Item $archive).Length / 1MB, 1) + 'MB sha=' + $sha.Substring(0, 12))

$hostRoot = Join-Path $env:LOCALAPPDATA 'U-Claw'
$hostEngines = Get-ChildItem (Join-Path $hostRoot '*\engine\*') -Directory -ErrorAction SilentlyContinue

function Reset-Host {
    Get-ChildItem (Join-Path $hostRoot '*\engine') -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
    }
}

# Run the real launcher headless and measure how long until /ready.
function Run-Launcher([string]$tag, [string]$mode) {
    Stop-Gateways
    $state = Join-Path $stick 'data\.openclaw'
    Remove-Item -Recurse -Force (Join-Path $stick 'data') -ErrorAction SilentlyContinue
    $log = Join-Path $Root ('run-' + $tag + '.log')
    $t0 = Get-Date
    $env:UCLAW_HEADLESS = '1'
    if ($mode) { $env:UCLAW_ENGINE_MODE = $mode } else { Remove-Item Env:UCLAW_ENGINE_MODE -ErrorAction SilentlyContinue }
    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + (Join-Path $stick 'Windows-Start.bat') + '"') -WorkingDirectory $stick -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')
    $ready = $false
    $deadline = (Get-Date).AddSeconds(420)
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) { break }
        if (Wait-Ready 18789 3) { $ready = $true; break }
    }
    $secs = [int]((Get-Date) - $t0).TotalSeconds
    $engineLine = (Select-String -Path $log -Pattern 'Engine:' -ErrorAction SilentlyContinue | Select-Object -First 1).Line
    $setupRan = [bool](Select-String -Path $log -Pattern 'Portable Setup' -ErrorAction SilentlyContinue)
    if (-not $proc.HasExited) { try { Stop-Process -Id $proc.Id -Force } catch { } }
    Stop-Gateways
    return @{ ready = $ready; secs = $secs; engine = ($engineLine -replace '\s+', ' '); setupRan = $setupRan; log = $log }
}

# ------------------------------------------------------------------- A cold first run
Log '--- case A: cold first run (host install) ---'
Reset-Host
$a = Run-Launcher 'A-cold' ''
$engineInstalled = [bool](Get-ChildItem (Join-Path $hostRoot '*\engine\' + $Version) -Directory -ErrorAction SilentlyContinue)
Record 'A_cold_first_run' @{ ok = ($a.ready -and -not $a.setupRan -and $engineInstalled); readySec = $a.secs; engine = $a.engine; hostInstalled = $engineInstalled; setupRan = $a.setupRan }

# ------------------------------------------------------------------- B warm second run
Log '--- case B: warm second run ---'
$b = Run-Launcher 'B-warm' ''
Record 'B_warm_second_run' @{ ok = ($b.ready -and -not $b.setupRan); readySec = $b.secs; engine = $b.engine; setupRan = $b.setupRan }

# ------------------------------------------------------------------- C forced drive
Log '--- case C: forced drive mode (the "cannot install" fallback) ---'
$c = Run-Launcher 'C-drive' 'drive'
$driveEngine = Test-Path (Join-Path $stick ('engine\' + $Version + '\app\core\node_modules\openclaw\openclaw.mjs'))
Record 'C_forced_drive' @{ ok = ($c.ready -and $driveEngine); readySec = $c.secs; engine = $c.engine; onStick = $driveEngine }

# ------------------------------------------------------------------- D corrupt archive
Log '--- case D: corrupt archive must fail cleanly ---'
Reset-Host
Stop-Gateways
Set-Content -Path ($archive + '.sha256') -Value ('0' * 64) -NoNewline -Encoding ASCII
$d = Run-Launcher 'D-corrupt' ''
$half = Get-ChildItem (Join-Path $hostRoot '*\engine\*.tmp-*') -Directory -ErrorAction SilentlyContinue
$installedD = [bool](Get-ChildItem (Join-Path $hostRoot '*\engine\' + $Version) -Directory -ErrorAction SilentlyContinue)
# Bad archive must not install on the host; the launcher may still fall back to the stick (drive).
Record 'D_corrupt_archive' @{ ok = (-not $installedD -and -not $half); hostInstalled = $installedD; leftoverTmp = [bool]$half; readySec = $d.secs; engine = $d.engine }
Set-Content -Path ($archive + '.sha256') -Value $sha -NoNewline -Encoding ASCII

# ------------------------------------------------------------------- E interrupted install
Log '--- case E: kill the installer mid-extract, rerun must recover ---'
Reset-Host
Stop-Gateways
Remove-Item -Recurse -Force (Join-Path $hostRoot '*\engine') -ErrorAction SilentlyContinue
$extract = Start-Process -FilePath 'tar.exe' -ArgumentList @('-xzf', $archive, '-C', (Join-Path $Root 'interrupt')) -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
try { Stop-Process -Id $extract.Id -Force -ErrorAction SilentlyContinue } catch { }
New-Item -ItemType Directory -Force -Path (Join-Path $hostRoot 'stale\engine\' + $Version + '.lock') | Out-Null
$e = Run-Launcher 'E-interrupted' ''
Record 'E_interrupted_install' @{ ok = $e.ready; readySec = $e.secs; engine = $e.engine }

# ------------------------------------------------------------------- F legacy layout
Log '--- case F: legacy layout (no archive -> loose app keeps working) ---'
Stop-Gateways
$legacy = Join-Path $Root 'legacy'
New-Item -ItemType Directory -Force -Path $legacy | Out-Null
& robocopy $skelDir $legacy /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
& robocopy (Join-Path $srcRoot 'app') (Join-Path $legacy 'app') /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
if (Test-Path (Join-Path $legacy 'extensions')) { } else { & robocopy (Join-Path $srcRoot 'extensions') (Join-Path $legacy 'extensions') /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null }
Remove-Item -Force (Join-Path $legacy 'engine-*.tar.gz') -ErrorAction SilentlyContinue
$env:UCLAW_HEADLESS = '1'
$env:UCLAW_ENGINE_MODE = ''
$flog = Join-Path $Root 'run-F-legacy.log'
$t0 = Get-Date
$fproc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + (Join-Path $legacy 'Windows-Start.bat') + '"') -WorkingDirectory $legacy -WindowStyle Hidden -PassThru -RedirectStandardOutput $flog -RedirectStandardError ($flog + '.err')
$fready = $false
while (((Get-Date) - $t0).TotalSeconds -lt 420 -and -not $fproc.HasExited) { if (Wait-Ready 18789 3) { $fready = $true; break } }
$engineLine = (Select-String -Path $flog -Pattern 'Engine:' -ErrorAction SilentlyContinue | Select-Object -First 1).Line
if (-not $fproc.HasExited) { try { Stop-Process -Id $fproc.Id -Force } catch { } }
Stop-Gateways
Record 'F_legacy_layout' @{ ok = $fready; readySec = [int]((Get-Date) - $t0).TotalSeconds; engine = ($engineLine -replace '\s+', ' ') }

# ------------------------------------------------------------------- summary
$summary = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    machine = $env:COMPUTERNAME
    openclaw = $Version
    root = $Root
    archiveMB = [math]::Round((Get-Item $archive).Length / 1MB, 1)
    failures = $script:failures
    results = $results
}
($summary | ConvertTo-Json -Depth 6) | Set-Content -Path $summaryPath -Encoding UTF8
Log ('=== DONE failures=' + $script:failures + ' summary=' + $summaryPath)
Get-Content $summaryPath
