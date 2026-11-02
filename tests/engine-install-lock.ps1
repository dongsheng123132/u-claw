#Requires -Version 5.1
# engine-install-lock.ps1 - does the engine installer survive a previous node.exe that
# is still running?
#
# The bug: Install-Engine() does `Remove-Item -Recurse -Force $Target` and then
# `Move-Item $tmp $Target`. On Windows a running node.exe cannot be deleted, so when
# `$Target` exists but is not recognized as a complete install (interrupted delete,
# crash during install, quarantined manifest) every boot fails to install and the
# launcher silently degrades to the copy on the stick.
#
# This test drives the REAL resolver (portable/lib/engine-host.ps1) as a child process,
# exactly the way Windows-Start.bat does, against a throwaway stick and a throwaway
# %LOCALAPPDATA%. No engine is installed system-wide and the user's real cache is never
# touched: the fake engine is a tar.gz holding a copy of a real node.exe plus two stub
# files.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\engine-install-lock.ps1 `
#       -EngineHost portable\lib\engine-host.ps1
#
# Exit code 0 = every case passed.

[CmdletBinding()]
param(
    # Resolver under test; point it at an old copy to reproduce the bug.
    [Parameter(Mandatory = $true)]
    [string]$EngineHost,
    # Scratch root. Always a temp dir, never a real engine location.
    [string]$Work = '',
    # How long a holder process is allowed to live before the retry loop should win.
    [int]$HolderGraceMs = 1200
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

if (-not $Work) { $Work = Join-Path $env:TEMP 'uclaw-engine-lock' }
$EngineHost = (Resolve-Path -LiteralPath $EngineHost).Path
$script:fail = 0
$script:run = 0

function Say([string]$m) { Write-Host ('[test] ' + $m) }

function Check([string]$Name, [bool]$Ok, [string]$Detail) {
    if ($Ok) { Say ('PASS  ' + $Name + $(if ($Detail) { '  -- ' + $Detail } else { '' })) }
    else { $script:fail++; Say ('FAIL  ' + $Name + $(if ($Detail) { '  -- ' + $Detail } else { '' })) }
}

function Stop-Holder($Proc) {
    if ($null -ne $Proc) {
        try { if (-not $Proc.HasExited) { Stop-Process -Id $Proc.Id -Force -ErrorAction Stop } } catch { }
        try { $null = $Proc.WaitForExit(5000) } catch { }
    }
}

# Start a node.exe that lives INSIDE $Target and holds the directory busy.
function Start-Holder([string]$Target) {
    $node = Join-Path $Target 'app\runtime\node-win-x64\node.exe'
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw ('holder node missing: ' + $node) }
    $p = Start-Process -FilePath $node -ArgumentList @('-e', 'setInterval(function(){},1000)') -PassThru -WindowStyle Hidden
    Start-Sleep -Milliseconds 400
    if ($p.HasExited) { throw 'holder node exited immediately' }
    return $p
}

$localAppData = Join-Path $Work 'localappdata'
$stick = Join-Path $Work 'stick'
$src = Join-Path $Work 'src'
$version = '2099.1.1'
$savedLocalAppData = $env:LOCALAPPDATA
$holders = New-Object System.Collections.ArrayList

try {
    # ---------------------------------------------------------------- scratch layout
    if (Test-Path -LiteralPath $Work) { Remove-Item -Recurse -Force -LiteralPath $Work }
    New-Item -ItemType Directory -Force -Path $localAppData, $stick, $src | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $src 'app\runtime\node-win-x64') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $src 'app\core\node_modules\openclaw') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $src 'extensions') | Out-Null

    $realNode = $null
    foreach ($c in @((Join-Path $env:ProgramFiles 'nodejs\node.exe'), ('C:\Program Files\nodejs\node.exe'))) {
        if (Test-Path -LiteralPath $c -PathType Leaf) { $realNode = $c; break }
    }
    if (-not $realNode) { throw 'no node.exe found on this machine to use as the fake engine runtime' }
    Copy-Item -LiteralPath $realNode -Destination (Join-Path $src 'app\runtime\node-win-x64\node.exe') -Force
    Set-Content -LiteralPath (Join-Path $src 'app\core\node_modules\openclaw\openclaw.mjs') -Value "console.log('stub');" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $src 'extensions\stub.txt') -Value 'stub' -Encoding ASCII

    # ---------------------------------------------------------------- fake stick
    New-Item -ItemType Directory -Force -Path (Join-Path $stick 'lib') | Out-Null
    Copy-Item -LiteralPath $EngineHost -Destination (Join-Path $stick 'lib\engine-host.ps1') -Force
    $archive = Join-Path $stick ('engine-' + $version + '.tar.gz')
    Push-Location $src
    try { & tar.exe -czf $archive app extensions 2>$null } finally { Pop-Location }
    if (-not (Test-Path -LiteralPath $archive)) { throw 'failed to pack the fake engine archive' }
    $sha = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath ($archive + '.sha256') -Value $sha -NoNewline -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $stick 'OPENCLAW_VERSION') -Value $version -NoNewline -Encoding ASCII

    # The child process must write its cache here, not into the live %LOCALAPPDATA%.
    $env:LOCALAPPDATA = $localAppData
    $resolver = Join-Path $stick 'lib\engine-host.ps1'
    $script:seq = 0

    function Invoke-Resolver([string]$Mode) {
        $script:seq++
        $out = Join-Path $Work ('r' + $script:seq + '.out')
        $err = Join-Path $Work ('r' + $script:seq + '.err')
        $savedMode = $env:UCLAW_ENGINE_MODE
        try {
            if ($Mode) { $env:UCLAW_ENGINE_MODE = $Mode }
            else { Remove-Item Env:UCLAW_ENGINE_MODE -ErrorAction SilentlyContinue }
            $p = Start-Process -FilePath 'powershell.exe' -PassThru -Wait -WindowStyle Hidden `
                -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $resolver, $stick) `
                -RedirectStandardOutput $out -RedirectStandardError $err
        } finally {
            if ($savedMode) { $env:UCLAW_ENGINE_MODE = $savedMode }
            else { Remove-Item Env:UCLAW_ENGINE_MODE -ErrorAction SilentlyContinue }
        }
        $kv = @{}
        foreach ($line in (Get-Content -LiteralPath $out -ErrorAction SilentlyContinue)) {
            $i = $line.IndexOf('=')
            if ($i -gt 0) { $kv[$line.Substring(0, $i)] = $line.Substring($i + 1) }
        }
        $text = ''
        if (Test-Path -LiteralPath $err) { $text = (Get-Content -LiteralPath $err -Raw -ErrorAction SilentlyContinue) }
        return @{ kv = $kv; source = [string]$kv['UCLAW_ENGINE_SOURCE']; root = [string]$kv['UCLAW_ENGINE_ROOT']; err = [string]$text }
    }

    function Test-NodeRuns([string]$Dir) {
        $node = Join-Path $Dir 'app\runtime\node-win-x64\node.exe'
        if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { return $false }
        try { return [bool](& $node '--version' 2>$null) } catch { return $false }
    }

    Say ('engine-host under test: ' + (Join-Path $stick 'lib\engine-host.ps1'))
    Say ('scratch root: ' + $Work)

    # -------------------------------------------------- 1. cold install still works
    $r1 = Invoke-Resolver ''
    $target = $r1.root
    Check '1 cold install reports installed' ($r1.source -eq 'installed') ('source=' + $r1.source)
    Check '1 engine tree is complete' (Test-NodeRuns $target) ('node --version ok in ' + $target)

    # -------------------------------------------------- 2. same version, engine running
    $h2 = Start-Holder $target
    $null = $holders.Add($h2)
    $r2 = Invoke-Resolver ''
    Check '2 restart while the engine runs reuses it' ($r2.source -eq 'existing') ('source=' + $r2.source)
    Check '2 reuse does not attempt a reinstall' (-not ($r2.err -match 'install failed')) ''
    Stop-Holder $h2

    $hostTarget = $r1.root
    Say ('host target under test: ' + $hostTarget)

    # -------------------------------------------------- 3. unusable-looking tree + running node
    # This is the field state after an interrupted delete or a crashed upgrade: the tree
    # is fine but manifest.json is gone, so Test-EngineInstalled() says "not installed".
    Remove-Item -LiteralPath (Join-Path $hostTarget 'manifest.json') -Force -ErrorAction SilentlyContinue
    $h3 = Start-Holder $hostTarget
    $null = $holders.Add($h3)
    $r3 = Invoke-Resolver ''
    Check '3 usable tree is reused when manifest.json is gone' ($r3.source -eq 'existing') ('source=' + $r3.source)
    Say ('   resolver stderr: ' + ($r3.err -replace '\s+', ' ').Trim())
    Stop-Holder $h3

    # -------------------------------------------------- 4. holder exits inside the retry window
    Remove-Item -LiteralPath (Join-Path $hostTarget 'manifest.json') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $hostTarget 'OPENCLAW_VERSION') -Force -ErrorAction SilentlyContinue
    $h4 = Start-Holder $hostTarget
    $null = $holders.Add($h4)
    $killer = Start-Job -ScriptBlock {
        param($ProcId, $Ms)
        Start-Sleep -Milliseconds $Ms
        Stop-Process -Id $ProcId -Force -ErrorAction SilentlyContinue
    } -ArgumentList $h4.Id, $HolderGraceMs
    $r4 = Invoke-Resolver ''
    try { $null = Wait-Job $killer -Timeout 15; Remove-Job $killer -Force } catch { }
    Check '4 reinstall wins once the old engine exits' ($r4.source -eq 'installed') ('source=' + $r4.source)
    Check '4 reinstalled tree is complete' (Test-NodeRuns $hostTarget) ('root=' + $hostTarget)
    Say ('   resolver stderr: ' + ($r4.err -replace '\s+', ' ').Trim())

    # -------------------------------------------------- 5. holder never exits -> actionable failure
    $target5 = $hostTarget
    Remove-Item -LiteralPath (Join-Path $target5 'manifest.json') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $target5 'OPENCLAW_VERSION') -Force -ErrorAction SilentlyContinue
    $h5 = Start-Holder $target5
    $null = $holders.Add($h5)
    $r5 = Invoke-Resolver ''
    $hintOk = ($r5.err -match 'still running') -or ($r5.err -match 'still in use')
    Check '5 locked target explains that a U-Claw engine is running' $hintOk ''
    Check '5 keeps the original Windows error text' ($r5.err -match 'denied' -or $r5.err -match 'being used by another process') ''
    $parent5 = Split-Path -Parent $target5
    $leftover = @(Get-ChildItem -LiteralPath $parent5 -Filter '*.tmp-*' -Force -ErrorAction SilentlyContinue)
    $locks = @(Get-ChildItem -LiteralPath $parent5 -Filter '*.lock' -Force -ErrorAction SilentlyContinue)
    Check '5 leaves no half-installed tree behind' ($leftover.Count -eq 0) ('tmp dirs=' + $leftover.Count)
    Check '5 releases the install lock' ($locks.Count -eq 0) ('lock dirs=' + $locks.Count)
    Check '5 still falls back to the stick instead of failing the launch' ($r5.source -eq 'drive' -or $r5.source -eq 'usb') ('source=' + $r5.source)
    Say ('   resolver stderr: ' + ($r5.err -replace '\s+', ' ').Trim())
    Stop-Holder $h5

    # -------------------------------------------------- 6. version bump next to a running engine
    $version2 = '2099.2.0'
    Set-Content -LiteralPath (Join-Path $stick 'OPENCLAW_VERSION') -Value $version2 -NoNewline -Encoding ASCII
    $archive2 = Join-Path $stick ('engine-' + $version2 + '.tar.gz')
    Copy-Item -LiteralPath $archive -Destination $archive2 -Force
    Set-Content -LiteralPath ($archive2 + '.sha256') -Value $sha -NoNewline -Encoding ASCII
    $h6 = Start-Holder $target5
    $null = $holders.Add($h6)
    $r6 = Invoke-Resolver ''
    Check '6 version bump installs into a fresh directory' ($r6.source -eq 'installed') ('source=' + $r6.source)
    Check '6 the new engine is not the busy directory' ($r6.root -ne $target5) ('root=' + $r6.root)
    Check '6 the running old engine is left alone' (-not $h6.HasExited) ''
    Stop-Holder $h6
}
finally {
    foreach ($h in $holders) { Stop-Holder $h }
    Get-Job -ErrorAction SilentlyContinue | Remove-Job -Force -ErrorAction SilentlyContinue
    if ($savedLocalAppData) { $env:LOCALAPPDATA = $savedLocalAppData }
    else { Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue }
}

if ($script:fail -eq 0) { Say 'RESULT ok all cases passed' } else { Say ('RESULT failed ' + $script:fail + ' check(s)') }
exit ([int]$script:fail)
