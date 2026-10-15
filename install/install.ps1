# U-Claw online installation reuses the complete portable installer.
# Usage: irm https://u-claw.org/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$NODE_VERSION = "v24.16.0"
$SourceUrl = 'https://codeload.github.com/dongsheng123132/u-claw/zip/refs/heads/main'
Set-ExecutionPolicy Bypass -Scope Process -Force -ErrorAction SilentlyContinue
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
if (-not [Environment]::Is64BitOperatingSystem) { throw 'U-Claw requires Windows x64.' }
$NativeArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($NativeArch -ne 'AMD64') { throw "Unsupported Windows architecture: $NativeArch (x64 required)." }

$TempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$WorkDir = Join-Path $TempRoot ('uclaw-source-' + [Guid]::NewGuid().ToString('N'))
$WorkDir = [IO.Path]::GetFullPath($WorkDir)
$TempPrefix = $TempRoot + [IO.Path]::DirectorySeparatorChar
if (-not $WorkDir.StartsWith($TempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Temporary installation directory must remain inside the temp root.'
}
[IO.Directory]::CreateDirectory($WorkDir) | Out-Null
try {
    Write-Host "Downloading U-Claw portable source (Node.js $NODE_VERSION)..."
    $Archive = Join-Path $WorkDir 'source.zip'
    Invoke-WebRequest -Uri $SourceUrl -OutFile $Archive -UseBasicParsing -TimeoutSec 180
    $ExtractRoot = Join-Path $WorkDir 'extracted'
    [IO.Directory]::CreateDirectory($ExtractRoot) | Out-Null
    $ExtractPrefix = [IO.Path]::GetFullPath($ExtractRoot) + [IO.Path]::DirectorySeparatorChar
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($Entry in $Zip.Entries) {
            $Name = $Entry.FullName.Replace('\', '/')
            if ($Name -ne 'u-claw-main/' -and -not $Name.StartsWith('u-claw-main/', [StringComparison]::Ordinal)) {
                throw "Unexpected source archive path: $Name"
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
    $SourceRoot = (Resolve-Path -LiteralPath (Join-Path $ExtractRoot 'u-claw-main/portable')).Path
    if (-not $SourceRoot.StartsWith($ExtractPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Portable source must remain inside this installation temporary directory.'
    }
    foreach ($Required in @('Windows-Start.bat', 'setup.bat', 'OPENCLAW_VERSION', 'default-config.json', 'lib/install-portable.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot $Required) -PathType Leaf)) {
            throw "Incomplete portable source: $Required"
        }
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
