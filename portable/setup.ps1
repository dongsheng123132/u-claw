param([switch]$AllPlatforms)
$ErrorActionPreference = 'Stop'
$nodeVersion = "v24.16.0"
if ($AllPlatforms) { throw 'Prepare macOS separately with setup.sh on a Mac; native dependencies cannot be shared with Windows.' }
$coreDir = Join-Path $PSScriptRoot 'app/core'
$nodeDir = Join-Path $PSScriptRoot 'app/runtime/node-win-x64'
$nodeExe = Join-Path $nodeDir 'node.exe'
$pin = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'OPENCLAW_VERSION') -Raw).Trim()

function Download([string]$Url, [string]$Destination) {
    & curl.exe -fL --retry 2 --connect-timeout 15 --max-time 300 $Url -o $Destination
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
}
# SHA256 用 .NET 而不用 Get-FileHash cmdlet：cmdlet 会被 PowerShell 模块路径污染掉
# （装过 PowerShell 7 的机器上 Windows PowerShell 5.1 可能加载到 Utility 7.x，cmdlet 消失）。
# .NET 类型每个 PowerShell 都在，失败面更小。返回小写 hex，与 SHASUMS256.txt 一致。
function Get-Sha256([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $hash = $sha.ComputeHash($stream)
            return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
        } finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}
if (Test-Path -LiteralPath $nodeExe) {
    if ((& $nodeExe --version) -ne $nodeVersion) { throw 'Old Node runtime. Extract the full release in a new folder; do not mix app folders.' }
} else {
    $downloadDir = Join-Path ([IO.Path]::GetTempPath()) ('uclaw-node-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
    $archiveName = "node-$nodeVersion-win-x64.zip"
    $archive = Join-Path $downloadDir $archiveName
    Download "https://nodejs.org/dist/$nodeVersion/SHASUMS256.txt" (Join-Path $downloadDir 'SHASUMS256.txt')
    try { Download "https://npmmirror.com/mirrors/node/$nodeVersion/$archiveName" $archive }
    catch { Download "https://nodejs.org/dist/$nodeVersion/$archiveName" $archive }
    $line = Get-Content -LiteralPath (Join-Path $downloadDir 'SHASUMS256.txt') | Where-Object { $_.EndsWith('  ' + $archiveName) }
    if (-not $line -or (Get-Sha256 $archive) -ne ($line -split '\s+')[0]) { throw 'Node archive checksum mismatch' }
    Expand-Archive -LiteralPath $archive -DestinationPath $downloadDir
    New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
    Copy-Item -Path (Join-Path $downloadDir "node-$nodeVersion-win-x64/*") -Destination $nodeDir -Recurse
    $resolved = (Resolve-Path -LiteralPath $downloadDir).Path
    if (-not $resolved.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe temporary path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
$package = Join-Path $coreDir 'node_modules/openclaw/package.json'
if (Test-Path -LiteralPath $package) {
    if ((Get-Content -LiteralPath $package -Raw | ConvertFrom-Json).version -ne $pin) { throw 'Old OpenClaw runtime. Extract the full release in a new folder.' }
    $platformFile=Join-Path $coreDir '.uclaw-runtime-platform'
    if (-not (Test-Path -LiteralPath $platformFile) -or (Get-Content -LiteralPath $platformFile -Raw).Trim() -ne 'win32-x64') { throw 'Unverified native runtime platform. Use a fresh Windows release folder.' }
} else {
    New-Item -ItemType Directory -Path $coreDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime-package.json') -Destination (Join-Path $coreDir 'package.json')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime-package-lock.json') -Destination (Join-Path $coreDir 'package-lock.json')
    $env:PATH = "$nodeDir;" + $env:PATH
    # npm cache goes through the local portable-cache resolver when available;
    # otherwise npm keeps its default user cache. Never APP_DIR\.npm-cache (USB).
    $stateDir = Join-Path $PSScriptRoot 'data/.openclaw'
    $cacheLines = & $nodeExe (Join-Path $PSScriptRoot 'lib/portable-cache.mjs') $stateDir $PSScriptRoot
    $cacheExit = $LASTEXITCODE
    if ($cacheExit -eq 0) {
        $npmCacheLine = $cacheLines | Where-Object { $_ -like 'UCLAW_NPM_CACHE_DIR=*' } | Select-Object -First 1
        if ($npmCacheLine) { $env:npm_config_cache = $npmCacheLine.Substring('UCLAW_NPM_CACHE_DIR='.Length).Trim() }
    } else {
        Remove-Item Env:npm_config_cache -ErrorAction SilentlyContinue
        Write-Warning 'No writable local cache directory; npm will use its default user cache (never the USB drive).'
    }
    & $nodeExe (Join-Path $nodeDir 'node_modules/npm/bin/npm-cli.js') ci --prefix $coreDir --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund --omit=dev --fetch-timeout=60000
    if ($LASTEXITCODE -ne 0) { throw 'OpenClaw installation failed' }
}
foreach ($patch in @('patch-managed-browser-root.mjs','patch-device-pairing-retry.mjs','patch-exfat-compatibility.mjs')) {
    & $nodeExe (Join-Path $PSScriptRoot "lib/$patch") $coreDir
    if ($LASTEXITCODE -ne 0) { throw "Runtime patch failed: $patch" }
}
& $nodeExe --check (Join-Path $coreDir 'node_modules/openclaw/dist/chrome-D7PwFEoa.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Browser runtime syntax check failed' }
& $nodeExe --check (Join-Path $coreDir 'node_modules/@openclaw/fs-safe/dist/replace-file.js')
if ($LASTEXITCODE -ne 0) { throw 'Filesystem runtime syntax check failed' }
[IO.File]::WriteAllText((Join-Path $coreDir '.uclaw-runtime-platform'), 'win32-x64')
Write-Host "Ready: OpenClaw $pin / Node $nodeVersion. Launch Windows-Start.bat on NTFS or exFAT."
