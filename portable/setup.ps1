param([switch]$AllPlatforms)
$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
$appDir = Join-Path $scriptDir "app"
$coreDir = Join-Path $appDir "core"
$runtimeDir = Join-Path $appDir "runtime"
$mirror = "https://registry.npmmirror.com"
$nodeMirror = "https://npmmirror.com/mirrors/node"
$nodeVersion = "v24.16.0"

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}
function Download-File([string]$Url, [string]$Destination) {
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source -fSL --connect-timeout 20 --max-time 300 --retry 2 $Url -o $Destination
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
    } else {
        Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -TimeoutSec 300
    }
}
function Download-NodeArchive([string]$ArchiveName, [string]$Destination) {
    try { Download-File "$nodeMirror/$nodeVersion/$ArchiveName" $Destination }
    catch { Download-File "https://nodejs.org/dist/$nodeVersion/$ArchiveName" $Destination }
}
function Remove-SetupScratch([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        -not ([IO.Path]::GetFileName($resolved).StartsWith("uclaw-setup-"))) {
        throw "Refusing scratch cleanup outside the expected temporary directory: $resolved"
    }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
function Install-WindowsNode([string]$TargetDir) {
    $nodeExe = Join-Path $TargetDir "node.exe"
    if (Test-Path -LiteralPath $nodeExe -PathType Leaf) {
        $installed = & $nodeExe --version 2>$null
        if ($LASTEXITCODE -eq 0 -and "$installed".Trim() -eq $nodeVersion) {
            Write-Host "  OK Node.js $nodeVersion (win-x64) is ready." -ForegroundColor Green
            return
        }
    }
    Write-Host "  Downloading Node.js $nodeVersion (win-x64)..." -ForegroundColor Cyan
    $scratch = Join-Path ([IO.Path]::GetTempPath()) ("uclaw-setup-" + [guid]::NewGuid().ToString("N"))
    Ensure-Directory $scratch
    try {
        $archiveName = "node-$nodeVersion-win-x64.zip"
        $archive = Join-Path $scratch $archiveName
        Download-NodeArchive $archiveName $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $scratch -Force
        Ensure-Directory $TargetDir
        $extracted = Join-Path $scratch "node-$nodeVersion-win-x64"
        Get-ChildItem -LiteralPath $extracted -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $TargetDir -Recurse -Force
        }
        $actual = & $nodeExe --version
        if ($LASTEXITCODE -ne 0 -or "$actual".Trim() -ne $nodeVersion) { throw "Node version verification failed: $actual" }
        [IO.File]::WriteAllText((Join-Path $TargetDir "UCLAW_NODE_VERSION"), "$nodeVersion`n", [Text.UTF8Encoding]::new($false))
    } finally { Remove-SetupScratch $scratch }
}
function Install-MacNode([string]$Platform, [string]$DirectoryName) {
    $target = Join-Path $runtimeDir $DirectoryName
    $marker = Join-Path $target "UCLAW_NODE_VERSION"
    if ((Test-Path -LiteralPath (Join-Path $target "bin/node")) -and
        (Test-Path -LiteralPath $marker) -and ((Get-Content -LiteralPath $marker -Raw).Trim() -eq $nodeVersion)) {
        Write-Host "  OK Node.js $nodeVersion ($Platform) is ready." -ForegroundColor Green
        return
    }
    $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
    if (-not $tar) { throw "tar.exe is required to prepare the Mac runtimes." }
    $scratch = Join-Path ([IO.Path]::GetTempPath()) ("uclaw-setup-" + [guid]::NewGuid().ToString("N"))
    Ensure-Directory $scratch
    try {
        $archiveName = "node-$nodeVersion-$Platform.tar.gz"
        $archive = Join-Path $scratch $archiveName
        Download-NodeArchive $archiveName $archive
        Ensure-Directory $target
        & $tar.Source -xzf $archive -C $target --strip-components=1
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $target "bin/node"))) {
            throw "Mac runtime extraction failed: $Platform"
        }
        [IO.File]::WriteAllText($marker, "$nodeVersion`n", [Text.UTF8Encoding]::new($false))
    } finally { Remove-SetupScratch $scratch }
}
try {
    Write-Host "U-Claw Portable Setup" -ForegroundColor Cyan
    Ensure-Directory $coreDir
    Ensure-Directory $runtimeDir
    # Exclusive handle works on NTFS and exFAT. Closing releases even after errors.
    $setupLock = [IO.File]::Open((Join-Path $appDir ".setup.lock"), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $windowsNodeTarget = Join-Path $runtimeDir "node-win-x64"
    Install-WindowsNode $windowsNodeTarget
    if ($AllPlatforms) {
        Install-MacNode "darwin-arm64" "node-mac-arm64"
        Install-MacNode "darwin-x64" "node-mac-x64"
    }
    $versionFile = Join-Path $scriptDir "OPENCLAW_VERSION"
    if (-not (Test-Path -LiteralPath $versionFile)) { $versionFile = Join-Path $scriptDir "../OPENCLAW_VERSION" }
    if (-not (Test-Path -LiteralPath $versionFile)) { throw "OPENCLAW_VERSION is missing." }
    $openclawVersion = (Get-Content -LiteralPath $versionFile -Raw).Trim()
    if ($openclawVersion -notmatch '^\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?$') { throw "Invalid OPENCLAW_VERSION." }
    $nodeExe = Join-Path $windowsNodeTarget "node.exe"
    $npmCli = Join-Path $windowsNodeTarget "node_modules/npm/bin/npm-cli.js"
    $env:PATH = "$windowsNodeTarget;$env:PATH"
    $packagePath = Join-Path $coreDir "package.json"
    if (Test-Path -LiteralPath $packagePath) {
        $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    } else { $package = [pscustomobject]@{ name = "u-claw-core"; version = "1.0.0"; private = $true } }
    # Derived runtime dependencies only. User state remains under data/.
    $package | Add-Member -MemberType NoteProperty -Name dependencies -Value ([pscustomobject]@{ openclaw = $openclawVersion }) -Force
    $package.PSObject.Properties.Remove("optionalDependencies")
    $tempPackage = "$packagePath.uclaw-tmp"
    [IO.File]::WriteAllText($tempPackage, ($package | ConvertTo-Json -Depth 20) + "`n", [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $packagePath) { [IO.File]::Replace($tempPackage, $packagePath, "$packagePath.uclaw-backup") }
    else { [IO.File]::Move($tempPackage, $packagePath) }
    Write-Host "  Installing/checking OpenClaw $openclawVersion..." -ForegroundColor Cyan
    & $nodeExe $npmCli install --prefix $coreDir --registry=$mirror --ignore-scripts --no-audit --no-fund --omit=dev --fetch-retries=2 --fetch-timeout=60000
    if ($LASTEXITCODE -ne 0) { throw "OpenClaw npm installation failed." }
    $installedPackage = Get-Content -LiteralPath (Join-Path $coreDir "node_modules/openclaw/package.json") -Raw | ConvertFrom-Json
    if ($installedPackage.version -ne $openclawVersion) { throw "Installed OpenClaw version does not match $openclawVersion." }
    & $nodeExe (Join-Path $scriptDir "lib/patch-managed-browser-root.mjs") $coreDir
    if ($LASTEXITCODE -ne 0) { throw "Managed browser vendor patch failed." }
    & $nodeExe (Join-Path $scriptDir "lib/patch-device-pairing-retry.mjs") $coreDir
    if ($LASTEXITCODE -ne 0) { throw "Pairing retry vendor patch failed." }
    & $nodeExe (Join-Path $scriptDir "lib/patch-control-ui-channels.mjs") $coreDir
    if ($LASTEXITCODE -ne 0) { throw "Channels Control UI vendor patch failed." }
    & $nodeExe (Join-Path $scriptDir "lib/patch-portable-filesystem.mjs") $coreDir
    if ($LASTEXITCODE -ne 0) { throw "Portable filesystem vendor patch failed." }
    & $nodeExe --check (Join-Path $coreDir "node_modules/openclaw/dist/chrome-D7PwFEoa.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Managed browser syntax verification failed." }
    & $nodeExe --check (Join-Path $coreDir "node_modules/@openclaw/fs-safe/dist/replace-file.js")
    if ($LASTEXITCODE -ne 0) { throw "Pairing retry syntax verification failed." }
    & $nodeExe --check (Join-Path $coreDir "node_modules/openclaw/dist/openclaw-cli-shim-I4WwJOH3.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Agent CLI shim syntax verification failed." }
    & $nodeExe --check (Join-Path $coreDir "node_modules/openclaw/dist/diagnostic-stability-bundle-vmtXgIWw.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Stability bundle syntax verification failed." }
    $runtimePlatform = & $nodeExe -p '[process.platform,process.arch].join(String.fromCharCode(45))'
    if ($LASTEXITCODE -ne 0 -or "$runtimePlatform".Trim() -ne "win32-x64") { throw "Runtime platform detection failed: $runtimePlatform" }
    [IO.File]::WriteAllText((Join-Path $coreDir ".uclaw-runtime-platform"), "$runtimePlatform`n", [Text.UTF8Encoding]::new($false))
    $skillsSource = Join-Path $scriptDir "skills-cn"
    $skillsTarget = Join-Path $coreDir "node_modules/openclaw/skills"
    if ((Test-Path -LiteralPath $skillsSource) -and (Test-Path -LiteralPath $skillsTarget)) {
        Get-ChildItem -LiteralPath $skillsSource -Directory | ForEach-Object {
            $target = Join-Path $skillsTarget $_.Name
            if (-not (Test-Path -LiteralPath $target)) { Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse }
        }
    }
    Write-Host "  Setup complete. Double-click Windows-Start.bat or Mac-Start.command." -ForegroundColor Green
    exit 0
} catch {
    Write-Host "  Setup failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($setupLock) { $setupLock.Dispose() }
}
