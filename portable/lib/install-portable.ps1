param(
    [Parameter(Mandatory=$true)][string]$SourceRoot,
    [string]$TargetRoot = (Join-Path $env:USERPROFILE '.uclaw')
)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $SourceRoot).Path.TrimEnd('\')
$target = [IO.Path]::GetFullPath($TargetRoot).TrimEnd('\')
if ($source -eq $target) { throw 'Source and installation folder must differ.' }
if (-not (Test-Path -LiteralPath (Join-Path $source 'Windows-Start.bat'))) { throw 'Portable source is incomplete.' }
New-Item -ItemType Directory -Force -Path $target | Out-Null
$backup = Join-Path $target ('data/backups/install-' + [Guid]::NewGuid().ToString('N'))
$previousApp = Join-Path $target 'app'
if (Test-Path -LiteralPath $previousApp) {
    $targetPrefix = $target + [IO.Path]::DirectorySeparatorChar
    if (-not ([IO.Path]::GetFullPath($previousApp).StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) -or
        -not ([IO.Path]::GetFullPath($backup).StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase))) {
        throw 'Refusing program backup outside the selected installation folder.'
    }
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    Move-Item -LiteralPath $previousApp -Destination (Join-Path $backup 'app')
}
# Preserve existing state; only refresh portable source and rebuildable runtime.
foreach ($item in Get-ChildItem -LiteralPath $source -Force) {
    if ($item.Name -in @('data','app')) { continue }
    $destination = Join-Path $target $item.Name
    if (Test-Path -LiteralPath $destination) {
        New-Item -ItemType Directory -Force -Path $backup | Out-Null
        Copy-Item -LiteralPath $destination -Destination $backup -Recurse -Force
    }
    Copy-Item -LiteralPath $item.FullName -Destination $target -Recurse -Force
}
if (Test-Path -LiteralPath (Join-Path $source 'app')) {
    & robocopy (Join-Path $source 'app') (Join-Path $target 'app') /E /R:1 /W:1 /NFL /NDL /NJH /NJS
    if ($LASTEXITCODE -ge 8) { throw "Runtime copy failed: $LASTEXITCODE" }
}
& (Join-Path $target 'setup.bat')
if ($LASTEXITCODE -ne 0) { throw "Portable setup failed: $LASTEXITCODE" }
$entry = Join-Path $target 'start.bat'
if (Test-Path -LiteralPath $entry) {
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    Copy-Item -LiteralPath $entry -Destination $backup -Force
}
[IO.File]::WriteAllText($entry, "@echo off`r`ncall `"%~dp0Windows-Start.bat`"`r`n", [Text.Encoding]::ASCII)
Write-Host "Installed: $target"
Write-Host "Start: $entry"
