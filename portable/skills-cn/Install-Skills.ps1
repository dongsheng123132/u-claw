$ErrorActionPreference = "Stop"

$UCLAW_DIR = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$SKILL_ZIP = Join-Path $UCLAW_DIR "skill_zip"
$SKILLS_TARGET = Join-Path $UCLAW_DIR "data\.openclaw\workspace\skills"
$TEMP_DIR = Join-Path $env:TEMP "uclaw-skill-install"

if (-not (Test-Path $SKILL_ZIP)) {
    Write-Host "[ERROR] skill_zip folder not found: $SKILL_ZIP"
    exit 1
}

if (-not (Test-Path $SKILLS_TARGET)) {
    Write-Host "[ERROR] OpenClaw skills folder not found"
    exit 1
}

Write-Host ""
Write-Host "========================================"
Write-Host "  Install Skills from ZIP"
Write-Host "========================================"
Write-Host ""

$installed = 0
$skipped = 0
$failed = 0

Get-ChildItem -Path $SKILL_ZIP -Filter "*.zip" | ForEach-Object {
    $zipFile = $_.FullName
    Write-Host "Processing: $($_.Name)"

    if (Test-Path $TEMP_DIR) {
        Remove-Item -Path $TEMP_DIR -Recurse -Force
    }
    New-Item -ItemType Directory -Path $TEMP_DIR -Force | Out-Null

    Expand-Archive -Path $zipFile -DestinationPath $TEMP_DIR -Force

    $skillMdPath = Join-Path $TEMP_DIR "SKILL.md"
    if (-not (Test-Path $skillMdPath)) {
        Write-Host "  [ERROR] Invalid ZIP - no SKILL.md"
        Remove-Item -Path $TEMP_DIR -Recurse -Force
        $failed++
        return
    }

    $skillName = $null

    $metaPath = Join-Path $TEMP_DIR "_meta.json"
    if (Test-Path $metaPath) {
        $meta = Get-Content $metaPath | ConvertFrom-Json
        if ($meta.name) {
            $skillName = $meta.name
        } elseif ($meta.slug) {
            $skillName = $meta.slug
        }
    }

    if (-not $skillName) {
        $skillContent = Get-Content $skillMdPath -Raw
        if ($skillContent -match 'slug:\s*(.+)') {
            $skillName = $matches[1].Trim()
        } elseif ($skillContent -match '^name:\s*(.+)') {
            $skillName = $matches[1].Trim()
        }
    }

    if (-not $skillName) {
        Write-Host "  [ERROR] Could not determine skill name"
        Remove-Item -Path $TEMP_DIR -Recurse -Force
        $failed++
        return
    }

    Write-Host "  Skill name: $skillName"

    $targetPath = Join-Path $SKILLS_TARGET $skillName
    if (Test-Path $targetPath) {
        Write-Host "  [SKIP] Already installed: $skillName"
        $skipped++
    } else {
        New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
        Copy-Item -Path (Join-Path $TEMP_DIR "*") -Destination $targetPath -Recurse -Force
        Write-Host "  [OK] Installed: $skillName"
        $installed++
    }

    Remove-Item -Path $TEMP_DIR -Recurse -Force
}

Write-Host ""
Write-Host "========================================"
Write-Host "  Done"
Write-Host "========================================"
Write-Host "  Installed: $installed"
Write-Host "  Skipped:   $skipped"
Write-Host "  Failed:    $failed"
Write-Host ""
Write-Host "  Restart OpenClaw to use new skills"
Write-Host ""
