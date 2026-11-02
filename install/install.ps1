# U-Claw online installation reuses the complete portable installer.
# Usage: irm https://u-claw.org/install.ps1 | iex
#        $env:UCLAW_DRY_RUN='1'; powershell -File install/install.ps1
#
# The source archive is pinned to a released tag and its SHA-256 is checked
# before anything is unpacked, so this script never follows a mutable branch.
# Release checklist: install/README.md -> "发版时如何更新固定版本与校验和".
$ErrorActionPreference = 'Stop'
$NODE_VERSION = "v24.22.1"

# --- Pinned install source -------------------------------------------------
# $PinnedUclawRef    immutable commit the installer downloads (not a branch).
# $PinnedUclawSha256 SHA-256 of the zip behind that commit (not the tar.gz used
#                    by install.sh), i.e. of
#   https://codeload.github.com/dongsheng123132/u-claw/zip/<commit>
# Both constants are updated together after a change lands on main:
#   scripts/print-install-pins.sh
# $env:UCLAW_REF may override the commit, but the digest is still enforced: an
# override without its own $env:UCLAW_SHA256 fails closed below.
$PinnedUclawRef = 'fde0eb6f35593ffffa247f7236a48708c008144f'
$PinnedUclawSha256 = '1cdcc42ad3af47d7de1f2d8841668471a3d5b5070ced36ab3c34624eb30435b5'
$UclawRef = if ($env:UCLAW_REF) { $env:UCLAW_REF } else { $PinnedUclawRef }
$UclawSha256 = if ($env:UCLAW_SHA256) { $env:UCLAW_SHA256 } else { $PinnedUclawSha256 }
$SourceUrl = "https://codeload.github.com/dongsheng123132/u-claw/zip/$UclawRef"
$DryRun = $env:UCLAW_DRY_RUN -eq '1'
Set-ExecutionPolicy Bypass -Scope Process -Force -ErrorAction SilentlyContinue
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
if (-not [Environment]::Is64BitOperatingSystem) { throw 'U-Claw requires Windows x64.' }
$NativeArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($NativeArch -ne 'AMD64') { throw "Unsupported Windows architecture: $NativeArch (x64 required)." }

if ($UclawRef -ne $PinnedUclawRef -and $UclawSha256 -eq $PinnedUclawSha256) {
    throw ("UCLAW_REF=$UclawRef was overridden but UCLAW_SHA256 was not. " +
        'Refusing to install an unverified archive; print the digest for that tag with: ' +
        "scripts/print-install-pins.sh $UclawRef")
}
if (-not (Get-Command Get-FileHash -ErrorAction SilentlyContinue)) {
    throw 'Get-FileHash is required to verify the download (PowerShell 4.0+ on Windows 8.1 or later).'
}
# codeload names the archive root after the tag without its leading "v".
$ArchiveRoot = 'u-claw-' + $UclawRef

$TempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$WorkDir = Join-Path $TempRoot ('uclaw-source-' + [Guid]::NewGuid().ToString('N'))
$WorkDir = [IO.Path]::GetFullPath($WorkDir)
$TempPrefix = $TempRoot + [IO.Path]::DirectorySeparatorChar
if (-not $WorkDir.StartsWith($TempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Temporary installation directory must remain inside the temp root.'
}
[IO.Directory]::CreateDirectory($WorkDir) | Out-Null
try {
    Write-Host "Downloading U-Claw portable source $UclawRef (Node.js $NODE_VERSION)..."
    $Archive = Join-Path $WorkDir 'source.zip'
    Invoke-WebRequest -Uri $SourceUrl -OutFile $Archive -UseBasicParsing -TimeoutSec 180

    # Verify the digest before anything parses or unpacks the archive.
    Write-Host 'Verifying SHA-256 of the source archive...'
    $ActualSha256 = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash
    if ($ActualSha256 -ne $UclawSha256) {
        throw ("Checksum mismatch: refusing to unpack the source archive.`n" +
            "  source:   $SourceUrl`n" +
            "  expected: $($UclawSha256.ToLowerInvariant())`n" +
            "  actual:   $($ActualSha256.ToLowerInvariant())`n" +
            'Nothing was installed. The download was corrupted or tampered with; ' +
            'retry, and if it keeps failing the release pin has to be updated.')
    }
    Write-Host "Checksum verified: $($UclawSha256.ToLowerInvariant())"

    $ExtractRoot = Join-Path $WorkDir 'extracted'
    [IO.Directory]::CreateDirectory($ExtractRoot) | Out-Null
    $ExtractPrefix = [IO.Path]::GetFullPath($ExtractRoot) + [IO.Path]::DirectorySeparatorChar
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($Entry in $Zip.Entries) {
            $Name = $Entry.FullName.Replace('\', '/')
            if ($Name -ne "$ArchiveRoot/" -and -not $Name.StartsWith("$ArchiveRoot/", [StringComparison]::Ordinal)) {
                throw "Unexpected source archive path: $Name (expected root $ArchiveRoot)"
            }
            if ($Name.Split('/') -contains '..' -or [IO.Path]::IsPathRooted($Name)) {
                throw 'Unsafe source archive path.'
            }
            $EntryPath = [IO.Path]::GetFullPath((Join-Path $ExtractRoot $Name))
            if (-not $EntryPath.StartsWith($ExtractPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Source archive escapes the extraction directory.'
            }
        }
    } finally {
        $Zip.Dispose()
    }
    Expand-Archive -LiteralPath $Archive -DestinationPath $ExtractRoot
    $SourceRoot = (Resolve-Path -LiteralPath (Join-Path $ExtractRoot "$ArchiveRoot/portable")).Path
    if (-not $SourceRoot.StartsWith($ExtractPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Portable source must remain inside this installation temporary directory.'
    }
    foreach ($Required in @('Windows-Start.bat', 'setup.bat', 'OPENCLAW_VERSION', 'default-config.json', 'lib/install-portable.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot $Required) -PathType Leaf)) {
            throw "Incomplete portable source: $Required"
        }
    }

    # Verification path only: used by the release checklist and by CI smoke tests.
    if ($DryRun) {
        Write-Host 'Dry run: archive verified and unpacked, nothing installed.'
        Write-Host "  ref:      $UclawRef"
        Write-Host "  sha256:   $($UclawSha256.ToLowerInvariant())"
        Write-Host "  root:     $ArchiveRoot"
        Write-Host "  portable: $SourceRoot"
        return
    }

    $ProfileRoot = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\', '/')
    $InstallTarget = [IO.Path]::GetFullPath((Join-Path $ProfileRoot '.uclaw'))
    if ([IO.Path]::GetDirectoryName($InstallTarget) -ne $ProfileRoot) { throw 'Unsafe installation directory.' }
    if (Test-Path -LiteralPath $InstallTarget) {
        if ((Get-Item -LiteralPath $InstallTarget -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Installation directory cannot be a junction or symbolic link.'
        }
    }
    # This shared action backs up the previous program and preserves user data.
    & (Join-Path $SourceRoot 'lib/install-portable.ps1') -SourceRoot $SourceRoot -TargetRoot $InstallTarget
} finally {
    # Only remove the exact, uniquely named temp directory created above.
    $ResolvedWork = [IO.Path]::GetFullPath($WorkDir)
    if ($ResolvedWork.StartsWith($TempPrefix, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($ResolvedWork) -match '^uclaw-source-[0-9a-f]{32}$' -and
        (Test-Path -LiteralPath $ResolvedWork -PathType Container) -and
        -not ((Get-Item -LiteralPath $ResolvedWork -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Remove-Item -LiteralPath $ResolvedWork -Recurse -Force
    }
}
