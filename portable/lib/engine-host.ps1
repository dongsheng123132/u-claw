#Requires -Version 5.1
# engine-host.ps1 - resolve the OpenClaw engine location for the portable build.
#
# New packaging (v2.5+): the stick ships one archive `engine-<version>.tar.gz`
# instead of a loose app/ tree (~45k small files). This script decides where the
# engine runs from and installs it on first use:
#
#   auto (default) : local disk cache; on any install failure fall back to the stick
#   host           : local disk cache only (fail loudly if it cannot install)
#   drive          : install under <root>\engine\<version> (self-contained stick)
#   usb / legacy   : run straight from the stick's loose app/ tree (old layout)
#
# Cache locations (same slot hash as lib/portable-cache.mjs):
#   %LOCALAPPDATA%\U-Claw\<slot>\engine\<version>
#
# The script prints KEY=VALUE lines consumed by Windows-Start.bat and always
# leaves the caller with a usable root: legacy layout when no archive is shipped.
#
# Safety: mkdir lock (one installer at a time), free-space precheck, atomic
# rename of a fully extracted temp dir, manifest.json for version pinning, and
# silent fallback to the stick so a customer is never blocked on a cache write.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Root
)

$ErrorActionPreference = 'Stop'

function Emit([string]$Key, [string]$Value) {
    [Console]::Out.WriteLine($Key + '=' + $Value)
}
function Note([string]$Message) {
    [Console]::Error.WriteLine('[engine] ' + $Message)
}

$rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$versionFile = Join-Path $rootFull 'OPENCLAW_VERSION'
$version = ''
if (Test-Path -LiteralPath $versionFile -PathType Leaf) {
    $version = (Get-Content -LiteralPath $versionFile -Raw).Trim()
}

$archive = ''
if ($version) { $archive = Join-Path $rootFull ('engine-' + $version + '.tar.gz') }

# Legacy layout (no engine archive): behave exactly like v2.4.x.
if (-not $version -or -not (Test-Path -LiteralPath $archive -PathType Leaf)) {
    Emit 'UCLAW_ENGINE_SOURCE' 'legacy'
    Emit 'UCLAW_ENGINE_ROOT' $rootFull
    exit 0
}

$mode = 'auto'
if ($env:UCLAW_ENGINE_MODE) { $mode = $env:UCLAW_ENGINE_MODE.Trim().ToLowerInvariant() }
if ($mode -eq 'usb' -or $mode -eq 'legacy') {
    Emit 'UCLAW_ENGINE_SOURCE' 'usb'
    Emit 'UCLAW_ENGINE_ROOT' $rootFull
    exit 0
}
if ($mode -ne 'host' -and $mode -ne 'drive' -and $mode -ne 'auto') { $mode = 'auto' }

# Stable per-stick slot so a different drive letter still hits the same cache.
function Get-Slot([string]$AbsoluteRoot) {
    $normalized = $AbsoluteRoot.ToLowerInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hex = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized)) | ForEach-Object { $_.ToString('x2') })
        return $hex.Substring(0, 16)
    } finally {
        $sha.Dispose()
    }
}

$cacheBase = $env:LOCALAPPDATA
if (-not $cacheBase) { $cacheBase = Join-Path ([IO.Path]::GetTempPath()) 'U-Claw' }
$slot = Get-Slot $rootFull
$hostDir = Join-Path (Join-Path (Join-Path (Join-Path $cacheBase 'U-Claw') $slot) 'engine') $version
$driveDir = Join-Path (Join-Path $rootFull 'engine') $version

function Test-EngineInstalled([string]$Dir) {
    $manifest = Join-Path $Dir 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return $false }
    try {
        $meta = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    } catch {
        return $false
    }
    if ($meta -and $meta.version -and ([string]$meta.version) -ne $version) { return $false }
    $node = Join-Path $Dir 'app\runtime\node-win-x64\node.exe'
    $core = Join-Path $Dir 'app\core\node_modules\openclaw\openclaw.mjs'
    return ((Test-Path -LiteralPath $node -PathType Leaf) -and (Test-Path -LiteralPath $core -PathType Leaf))
}

function Get-FreeBytes([string]$Dir) {
    try {
        $qualifier = (Split-Path -Qualifier $Dir).TrimEnd(':')
        $drive = Get-PSDrive -Name $qualifier -ErrorAction Stop
        return [double]$drive.Free
    } catch {
        return -1
    }
}

function Test-Archive([string]$Archive) {
    $sidecar = $Archive + '.sha256'
    if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) { return $true }
    try {
        $expected = ((Get-Content -LiteralPath $sidecar -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
        $actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($expected -ne $actual) {
            Note ('engine archive checksum mismatch (expected ' + $expected.Substring(0, 12) + '..., got ' + $actual.Substring(0, 12) + '...)')
            return $false
        }
        return $true
    } catch {
        Note ('checksum check failed: ' + $_.Exception.Message)
        return $false
    }
}

function Install-Engine([string]$Target) {
    if (-not (Test-Archive $archive)) { return $false }
    $parent = Split-Path -Parent $Target
    try {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    } catch {
        Note ('cannot create ' + $parent + ': ' + $_.Exception.Message)
        return $false
    }

    # Free-space precheck: archive expands to roughly 3.5x its size.
    try {
        $needBytes = (Get-Item -LiteralPath $archive).Length * 3.5
        $freeBytes = Get-FreeBytes $parent
        if ($freeBytes -ge 0 -and $freeBytes -lt $needBytes) {
            Note ('not enough space on ' + $parent + ': free ' + [math]::Round($freeBytes / 1MB) + 'MB, need ' + [math]::Round($needBytes / 1MB) + 'MB')
            return $false
        }
    } catch { }

    $lock = $Target + '.lock'
    $gotLock = $false
    try {
        New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null
        $gotLock = $true
    } catch {
        Note 'another process is installing the engine; using the stick for this run'
        return $false
    }

    $tmp = $Target + '.tmp-' + $PID
    try {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -Recurse -Force -LiteralPath $tmp }
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        & tar.exe -xzf $archive -C $tmp 2>$null
        if ($LASTEXITCODE -ne 0) { throw ('tar exit ' + $LASTEXITCODE) }
        $meta = [ordered]@{
            schemaVersion = 1
            product       = 'u-claw'
            version       = $version
            archive       = (Split-Path -Leaf $archive)
            installedAt   = (Get-Date).ToUniversalTime().ToString('o')
        }
        ($meta | ConvertTo-Json) | Set-Content -LiteralPath (Join-Path $tmp 'manifest.json') -Encoding UTF8
        if (Test-Path -LiteralPath $Target) {
            Remove-Item -Recurse -Force -LiteralPath $Target
        }
        Move-Item -LiteralPath $tmp -Destination $Target
        return $true
    } catch {
        Note ('install failed: ' + $_.Exception.Message)
        return $false
    } finally {
        if ($gotLock) { try { Remove-Item -Recurse -Force -LiteralPath $lock } catch { } }
        if (Test-Path -LiteralPath $tmp) { try { Remove-Item -Recurse -Force -LiteralPath $tmp } catch { } }
    }
}

$target = $hostDir
$source = 'existing'
if ($mode -eq 'drive') { $target = $driveDir }

if (-not (Test-EngineInstalled $target)) {
    $ok = Install-Engine $target
    if ($ok) {
        $source = 'installed'
    } elseif ($mode -ne 'drive') {
        # Fallback requested by the user: run from the stick instead of the host.
        $target = $driveDir
        if (Test-EngineInstalled $target -or (Install-Engine $target)) {
            $source = 'drive'
        } else {
            Emit 'UCLAW_ENGINE_SOURCE' 'usb'
            Emit 'UCLAW_ENGINE_ROOT' $rootFull
            exit 0
        }
    } else {
        Emit 'UCLAW_ENGINE_SOURCE' 'usb'
        Emit 'UCLAW_ENGINE_ROOT' $rootFull
        exit 0
    }
}

Emit 'UCLAW_ENGINE_SOURCE' $source
Emit 'UCLAW_ENGINE_MODE' $mode
Emit 'UCLAW_ENGINE_ROOT' $target
Emit 'UCLAW_NODE_BIN' (Join-Path $target 'app\runtime\node-win-x64\node.exe')
Emit 'UCLAW_CORE_DIR' (Join-Path $target 'app\core')
Emit 'UCLAW_APP_DIR' (Join-Path $target 'app')
