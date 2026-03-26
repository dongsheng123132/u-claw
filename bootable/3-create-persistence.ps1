# ============================================================
#  M-Claw Bootable USB - Step 3: Create Persistence Image
#  Creates persistence.dat for Ventoy
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  M-Claw Bootable USB - Step 3: Persistence" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── Config ──
$CacheDir = Join-Path $PSScriptRoot ".download-cache"
$PersistencePath = Join-Path $CacheDir "persistence.dat"
$DefaultSizeGB = 20

if (-not (Test-Path $CacheDir)) {
    New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null
}

# ── Check if persistence.dat already exists ──
if (Test-Path $PersistencePath) {
    $existingSize = [math]::Round((Get-Item $PersistencePath).Length / 1GB, 1)
    Write-Host "[INFO] persistence.dat already exists (${existingSize} GB)." -ForegroundColor Yellow
    $overwrite = Read-Host "Recreate it? (y/N)"
    if ($overwrite -ne "y" -and $overwrite -ne "Y") {
        Write-Host "[OK]   Using existing persistence.dat." -ForegroundColor Green
        Write-Host "       Next: Run .\4-copy-to-usb.ps1" -ForegroundColor Cyan
        Read-Host "Press Enter to continue"
        exit 0
    }
    Remove-Item -Path $PersistencePath -Force
}

# ── Detect usable WSL distro (must have bash + mkfs.ext4) ──
$wslDistro = $null
try {
    $distros = (wsl --list --quiet 2>$null) -replace "`0","" | Where-Object { $_.Trim() -ne "" -and $_ -notmatch "docker" }
    foreach ($d in $distros) {
        $d = $d.Trim()
        if ($d) {
            $testResult = wsl -d $d -- sh -c "command -v mkfs.ext4 && echo HASEXT4" 2>$null
            if ($testResult -match "HASEXT4") {
                $wslDistro = $d
                break
            }
        }
    }
} catch {}

if ($wslDistro) {
    # ── Method A: Use WSL distro to create ext4 image ──
    Write-Host "[INFO] Usable WSL distro found: $wslDistro" -ForegroundColor Green
    Write-Host ""

    $sizeInput = Read-Host "Persistence size in GB (default: $DefaultSizeGB for 32GB USB)"
    if ([string]::IsNullOrWhiteSpace($sizeInput)) {
        $sizeGB = $DefaultSizeGB
    } else {
        $sizeGB = [int]$sizeInput
    }

    if ($sizeGB -lt 1 -or $sizeGB -gt 28) {
        Write-Host "[ERROR] Size must be between 1 and 28 GB." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }

    Write-Host "[INFO] Creating ${sizeGB} GB ext4 image via WSL..." -ForegroundColor Yellow

    $sizeMB = $sizeGB * 1024
    $tmpFile = "/tmp/uclaw_persistence.dat"

    wsl -d $wslDistro -- sh -c "rm -f $tmpFile; dd if=/dev/zero of=$tmpFile bs=1M count=0 seek=$sizeMB 2>/dev/null; mkfs.ext4 -F -L casper-rw $tmpFile 2>/dev/null; echo DONE"

    # Copy out via \\wsl$
    $wslNetPath = "\\wsl$\$wslDistro\tmp\uclaw_persistence.dat"
    if (Test-Path $wslNetPath) {
        Write-Host "[INFO] Copying from WSL to cache..." -ForegroundColor Yellow
        Copy-Item -Path $wslNetPath -Destination $PersistencePath -Force
        wsl -d $wslDistro -- rm -f $tmpFile
    }

    if (Test-Path $PersistencePath) {
        $actualSize = [math]::Round((Get-Item $PersistencePath).Length / 1GB, 1)
        Write-Host "[OK]   Created ${actualSize} GB persistence image." -ForegroundColor Green
    } else {
        Write-Host "[ERROR] Failed to create persistence image via WSL." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }

} else {
    # ── Method B: Try docker-desktop WSL, fallback to raw file ──
    Write-Host "[INFO] No standard WSL distro found." -ForegroundColor Yellow

    $sizeInput = Read-Host "Persistence size in GB (default: $DefaultSizeGB for 32GB USB)"
    if ([string]::IsNullOrWhiteSpace($sizeInput)) {
        $sizeGB = $DefaultSizeGB
    } else {
        $sizeGB = [int]$sizeInput
    }

    if ($sizeGB -lt 1 -or $sizeGB -gt 28) {
        Write-Host "[ERROR] Size must be between 1 and 28 GB." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }

    $sizeMB = $sizeGB * 1024
    $formatted = $false

    # Try docker-desktop WSL (has /sbin/mkfs.ext4)
    $dockerWSL = $null
    try {
        $allDistros = (wsl --list --quiet 2>$null) -replace "`0","" | Where-Object { $_.Trim() -ne "" -and $_ -match "docker" }
        foreach ($d in $allDistros) {
            $d = $d.Trim()
            if ($d) {
                $testResult = wsl -d $d -- /sbin/mkfs.ext4 -V 2>&1
                if ($LASTEXITCODE -eq 0 -or "$testResult" -match "mke2fs") {
                    $dockerWSL = $d
                    break
                }
            }
        }
    } catch {}

    if ($dockerWSL) {
        Write-Host "[INFO] Found docker-desktop WSL with mkfs.ext4, creating ext4 image..." -ForegroundColor Green
        $tmpFile = "/tmp/uclaw_persistence.dat"

        # Create sparse file and format in docker-desktop WSL
        wsl -d $dockerWSL -- dd if=/dev/zero of=$tmpFile bs=1M count=0 seek=$sizeMB 2>$null
        wsl -d $dockerWSL -- /sbin/mkfs.ext4 -F -L casper-rw $tmpFile 2>$null

        # Copy out via /mnt/host/c/ (docker-desktop mounts C: there)
        $tmpHostPath = "C:\uclaw_persistence_tmp.dat"
        wsl -d $dockerWSL -- cp $tmpFile /mnt/host/c/uclaw_persistence_tmp.dat 2>$null

        if (Test-Path $tmpHostPath) {
            Move-Item -Path $tmpHostPath -Destination $PersistencePath -Force
            wsl -d $dockerWSL -- rm -f $tmpFile 2>$null
            $formatted = $true
            Write-Host "[OK]   ext4 image created via docker-desktop WSL." -ForegroundColor Green
        } else {
            Write-Host "[WARN] docker-desktop copy failed, falling back to raw file." -ForegroundColor Yellow
            wsl -d $dockerWSL -- rm -f $tmpFile 2>$null
        }
    }

    if (-not $formatted) {
        # Fallback: create raw sparse file
        Write-Host "[INFO] Creating ${sizeGB} GB sparse file (needs manual format in Linux)..." -ForegroundColor Yellow
        $sizeBytes = [int64]$sizeGB * 1024 * 1024 * 1024
        $fs = [System.IO.File]::Create($PersistencePath)
        $fs.SetLength($sizeBytes)
        $fs.Close()
    }

    if (Test-Path $PersistencePath) {
        $actualSize = [math]::Round((Get-Item $PersistencePath).Length / 1GB, 1)
        Write-Host "[OK]   Created ${actualSize} GB persistence file." -ForegroundColor Green
        if (-not $formatted) {
            Write-Host ""
            Write-Host "  IMPORTANT: File is NOT yet formatted as ext4!" -ForegroundColor Yellow
            Write-Host "  After first boot into Linux, run:" -ForegroundColor Yellow
            Write-Host '  sudo mkfs.ext4 -F -L casper-rw /media/*/Ventoy/persistence.dat' -ForegroundColor White
            Write-Host '  Then reboot for persistence to take effect.' -ForegroundColor White
        }
    } else {
        Write-Host "[ERROR] Failed to create persistence file." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
}

# ── Verify ext4 magic number ──
if (Test-Path $PersistencePath) {
    try {
        $f = [System.IO.File]::OpenRead($PersistencePath)
        $f.Seek(1080, 0) | Out-Null
        $buf = New-Object byte[] 2
        $f.Read($buf, 0, 2) | Out-Null
        $f.Close()
        $magic = "{0:X2}{1:X2}" -f $buf[0], $buf[1]
        if ($magic -eq "53EF") {
            Write-Host "[OK]   ext4 verified (magic: 0xEF53)." -ForegroundColor Green
        } else {
            Write-Host "[WARN] NOT a valid ext4 filesystem (magic: 0x$magic)." -ForegroundColor Yellow
            Write-Host "       You must format it in Linux before persistence will work." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "[WARN] Could not verify ext4 magic number." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "[OK]   Step 3 complete! Persistence image created." -ForegroundColor Green
Write-Host "       Path: $PersistencePath" -ForegroundColor White
Write-Host ""
Write-Host "       Next: Run .\4-copy-to-usb.ps1" -ForegroundColor Cyan
Read-Host "Press Enter to continue"
