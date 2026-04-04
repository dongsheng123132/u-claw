param(
    [switch]$AllPlatforms
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Join-Path $scriptDir "app"
$coreDir = Join-Path $appDir "core"
$runtimeDir = Join-Path $appDir "runtime"

$mirror = "https://registry.npmmirror.com"
$nodeMirror = "https://npmmirror.com/mirrors/node"
$nodeVersion = "v22.22.1"

function Write-Step {
    param(
        [string]$Symbol,
        [string]$Message,
        [string]$Color = "Gray"
    )

    Write-Host ("  {0} {1}" -f $Symbol, $Message) -ForegroundColor $Color
}

function Ensure-Directory {
    param(
        [string]$Path
    )

    if (-not (Test-Path -Path $Path -PathType Container)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Download-File {
    param(
        [string]$Url,
        [string]$Destination
    )

    Invoke-WebRequest -Uri $Url -OutFile $Destination
}

function Install-WindowsNode {
    param(
        [string]$TargetDir
    )

    $nodeExe = Join-Path $TargetDir "node.exe"
    if (Test-Path -Path $nodeExe -PathType Leaf) {
        Write-Step "OK" "Node.js (win-x64) already exists, skipping download." "Green"
        return
    }

    Write-Step "->" "Downloading Node.js $nodeVersion (win-x64)..." "Cyan"
    Ensure-Directory -Path $TargetDir

    $zipName = "node-$nodeVersion-win-x64.zip"
    $nodeUrl = "$nodeMirror/$nodeVersion/$zipName"
    $tempZip = Join-Path $env:TEMP $zipName
    $extractRoot = Join-Path $env:TEMP "uclaw-node-win-x64"
    $extractDir = Join-Path $extractRoot "node-$nodeVersion-win-x64"

    Write-Host "    $nodeUrl"
    Download-File -Url $nodeUrl -Destination $tempZip

    if (Test-Path -Path $extractRoot) {
        Remove-Item -Path $extractRoot -Recurse -Force
    }

    Expand-Archive -Path $tempZip -DestinationPath $extractRoot -Force
    Copy-Item -Path (Join-Path $extractDir "*") -Destination $TargetDir -Recurse -Force

    Remove-Item -Path $tempZip -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $extractRoot -Recurse -Force -ErrorAction SilentlyContinue

    if (Test-Path -Path $nodeExe -PathType Leaf) {
        Write-Step "OK" "Node.js (win-x64) download completed." "Green"
    }
    else {
        Write-Step "ERR" "Node.js (win-x64) download failed." "Red"
        exit 1
    }
}

function Install-TarNodeRuntime {
    param(
        [string]$Platform,
        [string]$NodeDirName
    )

    $targetDir = Join-Path $runtimeDir $NodeDirName
    $nodeBinary = Join-Path $targetDir "bin/node"
    if (Test-Path -Path $nodeBinary -PathType Leaf) {
        Write-Step "OK" "Node.js ($Platform) already exists, skipping download." "Green"
        return
    }

    $tarExe = Get-Command tar.exe -ErrorAction SilentlyContinue
    if (-not $tarExe) {
        Write-Step "WARN" "tar.exe was not found, skipping $Platform runtime." "Yellow"
        return
    }

    Write-Step "->" "Downloading Node.js $nodeVersion ($Platform)..." "Cyan"
    Ensure-Directory -Path $targetDir

    $archiveName = "node-$nodeVersion-$Platform.tar.gz"
    $nodeUrl = "$nodeMirror/$nodeVersion/$archiveName"
    $tempArchive = Join-Path $env:TEMP $archiveName
    $extractRoot = Join-Path $env:TEMP ("uclaw-{0}" -f $NodeDirName)
    $extractDir = Join-Path $extractRoot "node-$nodeVersion-$Platform"

    Write-Host "    $nodeUrl"
    Download-File -Url $nodeUrl -Destination $tempArchive

    if (Test-Path -Path $extractRoot) {
        Remove-Item -Path $extractRoot -Recurse -Force
    }

    Ensure-Directory -Path $extractRoot
    & $tarExe.Path -xzf $tempArchive -C $extractRoot

    if ($LASTEXITCODE -ne 0) {
        Write-Step "WARN" "$Platform runtime extraction failed, skipping it." "Yellow"
        Remove-Item -Path $tempArchive -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
        return
    }

    Copy-Item -Path (Join-Path $extractDir "*") -Destination $targetDir -Recurse -Force
    Remove-Item -Path $tempArchive -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $extractRoot -Recurse -Force -ErrorAction SilentlyContinue

    if (Test-Path -Path $nodeBinary -PathType Leaf) {
        Write-Step "OK" "Node.js ($Platform) download completed." "Green"
    }
    else {
        Write-Step "WARN" "$Platform runtime download failed, but Windows setup can continue." "Yellow"
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  U-Claw Portable Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host ("  System: {0}" -f [System.Runtime.InteropServices.RuntimeInformation]::OSDescription) -ForegroundColor Green
Write-Host ""

Ensure-Directory -Path $appDir
Ensure-Directory -Path $coreDir
Ensure-Directory -Path $runtimeDir

$windowsNodeTarget = Join-Path $runtimeDir "node-win-x64"
Install-WindowsNode -TargetDir $windowsNodeTarget

if ($AllPlatforms) {
    Install-TarNodeRuntime -Platform "darwin-arm64" -NodeDirName "node-mac-arm64"
    Install-TarNodeRuntime -Platform "darwin-x64" -NodeDirName "node-mac-x64"
}

$packageJsonPath = Join-Path $coreDir "package.json"
if (-not (Test-Path -Path $packageJsonPath -PathType Leaf)) {
    $packageJson = @'
{
  "name": "u-claw-core",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "openclaw": "latest"
  }
}
'@
    $packageJson | Out-File -FilePath $packageJsonPath -Encoding utf8
}

$npmCmd = Join-Path $windowsNodeTarget "npm.cmd"

if (Test-Path -Path (Join-Path $coreDir "node_modules\openclaw") -PathType Container) {
    Write-Step "OK" "OpenClaw is already installed, skipping." "Green"
}
else {
    Write-Step "->" "Installing OpenClaw..." "Cyan"
    & $npmCmd install --prefix $coreDir --registry=$mirror

    if (Test-Path -Path (Join-Path $coreDir "node_modules\openclaw") -PathType Container) {
        Write-Step "OK" "OpenClaw installation completed." "Green"
    }
    else {
        Write-Step "ERR" "OpenClaw installation failed." "Red"
        exit 1
    }
}

if (Test-Path -Path (Join-Path $coreDir "node_modules\@sliverp\qqbot") -PathType Container) {
    Write-Step "OK" "QQ plugin is already installed, skipping." "Green"
}
else {
    Write-Step "->" "Installing QQ plugin..." "Cyan"
    try {
        & $npmCmd install @sliverp/qqbot@latest --prefix $coreDir --registry=$mirror 2>$null
    }
    catch {
    }
    Write-Step "OK" "QQ plugin installation finished." "Green"
}

$skillsCn = Join-Path $scriptDir "skills-cn"
$skillsTarget = Join-Path $coreDir "node_modules\openclaw\skills"

if ((Test-Path -Path $skillsCn -PathType Container) -and (Test-Path -Path $skillsTarget -PathType Container)) {
    Write-Step "->" "Installing localized skills from skills-cn..." "Cyan"
    $skillCount = 0
    Get-ChildItem -Path $skillsCn -Directory | ForEach-Object {
        $targetPath = Join-Path $skillsTarget $_.Name
        if (-not (Test-Path -Path $targetPath -PathType Container)) {
            Copy-Item -Path $_.FullName -Destination $targetPath -Recurse -Force
            $skillCount++
        }
    }
    Write-Step "OK" ("Localized skills installed (+{0})." -f $skillCount) "Green"
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Setup Complete" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Launch:"
Write-Host "    Mac:     bash Mac-Start.command" -ForegroundColor Cyan
Write-Host "    Windows: double-click Windows-Start.bat" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Structure:"
Write-Host "    app/core/       -> OpenClaw and dependencies"
Write-Host "    app/runtime/    -> Node.js $nodeVersion"
Write-Host "    data/           -> created automatically after launch"
Write-Host ""
Write-Host "  Tip: use .\setup.ps1 -AllPlatforms to prepare a cross-platform USB." -ForegroundColor Cyan
