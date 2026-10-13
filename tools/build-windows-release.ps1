param([Parameter(Mandatory=$true)][string]$OutputDir)
$ErrorActionPreference='Stop'
$source=Split-Path -Parent $PSScriptRoot
Push-Location $source
try {
    if (git status --porcelain) { throw 'Commit source before building a release' }
    $revision=(git rev-parse HEAD).Trim()
    $tag='v'+(Get-Content -LiteralPath 'VERSION' -Raw).Trim()
    $name="u-claw-portable-windows-$tag"
    $output=[IO.Path]::GetFullPath($OutputDir)
    $stage=Join-Path $output $name
    if (Test-Path -LiteralPath $stage) { throw 'Output stage already exists; choose a new output directory' }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    $skeleton=Join-Path $output 'skeleton.tar'
    git archive --format=tar --output=$skeleton HEAD:portable
    if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
    & tar.exe -xf $skeleton -C $stage
    if ($LASTEXITCODE -ne 0) { throw 'Source extraction failed' }
    Remove-Item -LiteralPath $skeleton
    Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object { $_.Extension -in '.bat','.cmd','.ps1' } | ForEach-Object {
        $text=[IO.File]::ReadAllText($_.FullName).Replace("`r`n","`n").Replace("`n","`r`n")
        [IO.File]::WriteAllText($_.FullName,$text,[Text.UTF8Encoding]::new($false))
    }
    & (Join-Path $stage 'setup.ps1')
    $node=Join-Path $stage 'app/runtime/node-win-x64/node.exe'
    & $node (Join-Path $stage 'lib/runtime-preflight.mjs') $stage
    if ($LASTEXITCODE -ne 0) { throw 'Runtime preflight failed' }
    & $node --test 'tests/*.test.mjs'
    if ($LASTEXITCODE -ne 0) { throw 'Source tests failed' }
    $pin=(Get-Content -LiteralPath 'OPENCLAW_VERSION' -Raw).Trim()
    $info=@{tag=$tag;sourceRevision=$revision;openclaw=$pin;node=(& $node --version);platform='win32-x64';runtimeLockSha256=(Get-FileHash -LiteralPath (Join-Path $stage 'runtime-package-lock.json')).Hash.ToLowerInvariant()}
    $info | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'BUILD-INFO.json') -Encoding utf8
    Copy-Item -LiteralPath "docs/release-notes/$tag.md" -Destination (Join-Path $stage 'RELEASE-NOTES.md')
    $zip=Join-Path $output "$name.zip"
    & python (Join-Path $PSScriptRoot 'zip-portable.py') $stage $zip
    if ($LASTEXITCODE -ne 0) { throw 'Archive verification failed' }
    $hash=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$zip.sha256", "$hash  $name.zip`n",[Text.Encoding]::ASCII)
    $info.archive=$zip; $info.sha256=$hash
    $info | ConvertTo-Json
} finally { Pop-Location }
