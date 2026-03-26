# ============================================================
#  M-Claw Bootable USB - Step 2: Download Ubuntu 24.04 ISO
#  Downloads and verifies Ubuntu desktop ISO
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  M-Claw Bootable USB - Step 2: Ubuntu ISO" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── Config ──
$ISOName = "ubuntu-24.04.4-desktop-amd64.iso"
$SHA256Expected = "3a4c9877b483ab46d7c3fbe165a0db275e1ae3cfe56a5657e5a47c2f99a99d1e"
$CacheDir = Join-Path $PSScriptRoot ".download-cache"
$ISOPath = Join-Path $CacheDir $ISOName

# Mirror list (China mirrors first)
$Mirrors = @(
    "https://mirrors.tuna.tsinghua.edu.cn/ubuntu-releases/24.04.4/$ISOName",
    "https://mirrors.aliyun.com/ubuntu-releases/24.04.4/$ISOName",
    "https://mirrors.ustc.edu.cn/ubuntu-releases/24.04.4/$ISOName",
    "https://releases.ubuntu.com/24.04.4/$ISOName"
)

# ── Create cache directory ──
if (-not (Test-Path $CacheDir)) {
    New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null
}

# ── Check existing download ──
if (Test-Path $ISOPath) {
    Write-Host "[INFO] ISO file found in cache. Verifying SHA256..." -ForegroundColor Yellow
    $hash = (Get-FileHash -Path $ISOPath -Algorithm SHA256).Hash.ToLower()
    if ($hash -eq $SHA256Expected) {
        Write-Host "[OK]   SHA256 verified. ISO is valid." -ForegroundColor Green
        Write-Host "       Path: $ISOPath" -ForegroundColor White
        Write-Host ""
        Write-Host "       Next: Run .\3-create-persistence.ps1" -ForegroundColor Cyan
        Read-Host "Press Enter to continue"
        exit 0
    } else {
        Write-Host "[WARN] SHA256 mismatch! Re-downloading..." -ForegroundColor Red
        Write-Host "       Expected: $SHA256Expected" -ForegroundColor Gray
        Write-Host "       Got:      $hash" -ForegroundColor Gray
        Remove-Item -Path $ISOPath -Force
    }
}

# ── Download ISO ──
Write-Host "[INFO] Downloading Ubuntu 24.04.4 Desktop (~5.8 GB)..." -ForegroundColor Yellow
Write-Host "       This will take a while depending on your connection." -ForegroundColor Gray
Write-Host ""

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$downloaded = $false
foreach ($mirror in $Mirrors) {
    $mirrorHost = ([System.Uri]$mirror).Host
    Write-Host "       Trying $mirrorHost ..." -ForegroundColor Gray
    try {
        $ProgressPreference = 'Continue'
        Invoke-WebRequest -Uri $mirror -OutFile $ISOPath -UseBasicParsing
        $downloaded = $true
        Write-Host "[OK]   Downloaded from $mirrorHost" -ForegroundColor Green
        break
    } catch {
        Write-Host "       Failed: $($_.Exception.Message)" -ForegroundColor DarkGray
        if (Test-Path $ISOPath) { Remove-Item -Path $ISOPath -Force }
        continue
    }
}

if (-not $downloaded) {
    Write-Host ""
    Write-Host "[ERROR] All download mirrors failed." -ForegroundColor Red
    Write-Host "        Please download Ubuntu 24.04.4 Desktop ISO manually:" -ForegroundColor Yellow
    Write-Host "        https://releases.ubuntu.com/24.04.4/" -ForegroundColor Yellow
    Write-Host "        Save it as: $ISOPath" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# ── Verify SHA256 ──
Write-Host "[INFO] Verifying SHA256 checksum..." -ForegroundColor Yellow
$hash = (Get-FileHash -Path $ISOPath -Algorithm SHA256).Hash.ToLower()
if ($hash -eq $SHA256Expected) {
    Write-Host "[OK]   SHA256 verified! ISO is authentic." -ForegroundColor Green
} else {
    Write-Host "[WARN] SHA256 mismatch!" -ForegroundColor Red
    Write-Host "       Expected: $SHA256Expected" -ForegroundColor Gray
    Write-Host "       Got:      $hash" -ForegroundColor Gray
    Write-Host ""
    Write-Host "       The ISO may be corrupted or a newer version." -ForegroundColor Yellow
    Write-Host "       You can continue at your own risk, or re-download." -ForegroundColor Yellow
    $cont = Read-Host "Continue anyway? (y/N)"
    if ($cont -ne "y" -and $cont -ne "Y") {
        Remove-Item -Path $ISOPath -Force
        exit 1
    }
}

Write-Host ""
Write-Host "[OK]   Step 2 complete! ISO saved to:" -ForegroundColor Green
Write-Host "       $ISOPath" -ForegroundColor White
Write-Host ""
Write-Host "       Next: Run .\3-create-persistence.ps1" -ForegroundColor Cyan
Read-Host "Press Enter to continue"
