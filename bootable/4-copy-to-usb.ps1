# ============================================================
#  M-Claw Bootable USB - Step 4: Copy Files to USB
#  Copies ISO, persistence, Ventoy config, and setup scripts
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  M-Claw Bootable USB - Step 4: Copy to USB" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── Config ──
$CacheDir = Join-Path $PSScriptRoot ".download-cache"
$ISOName = "ubuntu-24.04.4-desktop-amd64.iso"
$ISOPath = Join-Path $CacheDir $ISOName
$PersistencePath = Join-Path $CacheDir "persistence.dat"
$VentoyConfigDir = Join-Path $PSScriptRoot "ventoy"
$LinuxSetupDir = Join-Path $PSScriptRoot "linux-setup"

# ── Verify required files ──
$missing = @()
if (-not (Test-Path $ISOPath)) { $missing += "ISO ($ISOPath)" }
if (-not (Test-Path $PersistencePath)) { $missing += "persistence.dat ($PersistencePath)" }
if (-not (Test-Path "$VentoyConfigDir\ventoy.json")) { $missing += "ventoy.json" }

if ($missing.Count -gt 0) {
    Write-Host "[ERROR] Missing required files:" -ForegroundColor Red
    foreach ($m in $missing) {
        Write-Host "        - $m" -ForegroundColor Red
    }
    Write-Host ""
    Write-Host "        Please run the previous scripts first:" -ForegroundColor Yellow
    Write-Host "        .\2-download-iso.ps1 and .\3-create-persistence.ps1" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# ── Find Ventoy USB drive ──
Write-Host "[INFO] Looking for Ventoy USB drive..." -ForegroundColor Yellow

$ventoyDrive = $null
$volumes = Get-Volume | Where-Object { $_.DriveType -eq "Removable" -or $_.FileSystemLabel -match "(?i)ventoy" }

foreach ($vol in $volumes) {
    if ($vol.FileSystemLabel -match "(?i)ventoy" -and $vol.DriveLetter) {
        $ventoyDrive = "$($vol.DriveLetter):"
        break
    }
}

if (-not $ventoyDrive) {
    # Fallback: check all removable drives for VENTOY label
    $removable = Get-Volume | Where-Object { $_.DriveType -eq "Removable" -and $_.DriveLetter }
    if ($removable.Count -eq 0) {
        Write-Host "[ERROR] No removable USB drives found." -ForegroundColor Red
        Write-Host "        Make sure the Ventoy USB is inserted." -ForegroundColor Yellow
        Read-Host "Press Enter to exit"
        exit 1
    }

    Write-Host "[INFO] Could not auto-detect Ventoy drive. Available removable drives:" -ForegroundColor Yellow
    $removable | Format-Table DriveLetter, FileSystemLabel, @{
        Label = "Size (GB)"
        Expression = { [math]::Round($_.Size / 1GB, 1) }
    } -AutoSize

    $driveLetter = Read-Host "Enter the drive letter of your Ventoy USB (e.g., E)"
    $ventoyDrive = "${driveLetter}:"

    if (-not (Test-Path $ventoyDrive)) {
        Write-Host "[ERROR] Drive $ventoyDrive does not exist." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
}

Write-Host "[OK]   Ventoy drive found: $ventoyDrive" -ForegroundColor Green

# ── Check free space ──
$driveInfo = Get-PSDrive -Name $ventoyDrive.TrimEnd(':')
$freeGB = [math]::Round($driveInfo.Free / 1GB, 1)
$isoSizeGB = [math]::Round((Get-Item $ISOPath).Length / 1GB, 1)
$persGB = [math]::Round((Get-Item $PersistencePath).Length / 1GB, 1)
$needGB = $isoSizeGB + $persGB + 0.1

Write-Host "[INFO] Free space: ${freeGB} GB | Need: ~${needGB} GB (ISO: ${isoSizeGB} + Persistence: ${persGB})" -ForegroundColor Yellow

if ($freeGB -lt $needGB) {
    Write-Host "[ERROR] Not enough free space on $ventoyDrive" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# ── Confirm ──
Write-Host ""
Write-Host "Will copy to $ventoyDrive :" -ForegroundColor White
Write-Host "  - $ISOName (${isoSizeGB} GB)" -ForegroundColor White
Write-Host "  - persistence.dat (${persGB} GB)" -ForegroundColor White
Write-Host "  - ventoy/ventoy.json" -ForegroundColor White
Write-Host "  - u-claw-linux/ (setup scripts)" -ForegroundColor White
Write-Host ""

$confirm = Read-Host "Proceed? (Y/n)"
if ($confirm -eq "n" -or $confirm -eq "N") {
    Write-Host "Cancelled." -ForegroundColor Yellow
    exit 0
}

# ── Copy files ──
Write-Host ""
Write-Host "[1/4] Copying ISO (~${isoSizeGB} GB, please wait)..." -ForegroundColor Yellow
Copy-Item -Path $ISOPath -Destination "$ventoyDrive\$ISOName" -Force
Write-Host "      Done." -ForegroundColor Green

Write-Host "[2/4] Copying persistence.dat (~${persGB} GB)..." -ForegroundColor Yellow
Copy-Item -Path $PersistencePath -Destination "$ventoyDrive\persistence.dat" -Force
Write-Host "      Done." -ForegroundColor Green

Write-Host "[3/4] Copying Ventoy configuration..." -ForegroundColor Yellow
$ventoyDestDir = "$ventoyDrive\ventoy"
if (-not (Test-Path $ventoyDestDir)) {
    New-Item -ItemType Directory -Path $ventoyDestDir -Force | Out-Null
}
Copy-Item -Path "$VentoyConfigDir\ventoy.json" -Destination "$ventoyDestDir\ventoy.json" -Force
Write-Host "      Done." -ForegroundColor Green

Write-Host "[4/4] Copying Linux setup scripts..." -ForegroundColor Yellow
$linuxDestDir = "$ventoyDrive\u-claw-linux"
if (Test-Path $linuxDestDir) {
    Remove-Item -Path $linuxDestDir -Recurse -Force
}
Copy-Item -Path $LinuxSetupDir -Destination $linuxDestDir -Recurse -Force
Write-Host "      Done." -ForegroundColor Green

# ── Done ──
Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  USB Drive Ready!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Your bootable USB is ready to use!" -ForegroundColor White
Write-Host ""
Write-Host "  How to boot:" -ForegroundColor Cyan
Write-Host "  1. Insert the USB into the target computer" -ForegroundColor White
Write-Host "  2. Restart and press the boot key:" -ForegroundColor White
Write-Host "     - Dell:    F12" -ForegroundColor Gray
Write-Host "     - Lenovo:  F12" -ForegroundColor Gray
Write-Host "     - HP:      F9" -ForegroundColor Gray
Write-Host "     - ASUS:    F2 or DEL" -ForegroundColor Gray
Write-Host "     - Acer:    F12" -ForegroundColor Gray
Write-Host "     - MSI:     F11" -ForegroundColor Gray
Write-Host "  3. Select USB device from boot menu" -ForegroundColor White
Write-Host "  4. Ventoy menu -> Select Ubuntu" -ForegroundColor White
Write-Host "  5. Ubuntu boots with persistence enabled" -ForegroundColor White
Write-Host ""
Write-Host "  First time in Linux:" -ForegroundColor Cyan
Write-Host "  1. Connect to Wi-Fi" -ForegroundColor White
Write-Host "  2. Open Terminal" -ForegroundColor White
Write-Host '  3. sudo bash /media/*/Ventoy/u-claw-linux/setup-openclaw.sh' -ForegroundColor White
Write-Host "  4. Double-click 'M-Claw AI Assistant' on desktop" -ForegroundColor White
Write-Host ""
Read-Host "Press Enter to close"
