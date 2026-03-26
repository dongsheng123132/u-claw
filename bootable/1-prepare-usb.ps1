# ============================================================
#  M-Claw Bootable USB - Step 1: Prepare USB with Ventoy
#  Downloads Ventoy and launches its installer
# ============================================================

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  M-Claw Bootable USB - Step 1: Ventoy" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── Config ──
$VentoyVersion = "1.0.99"
$VentoyUrl = "https://github.com/ventoy/Ventoy/releases/download/v${VentoyVersion}/ventoy-${VentoyVersion}-windows.zip"
$CacheDir = Join-Path $PSScriptRoot ".download-cache"
$VentoyZip = Join-Path $CacheDir "ventoy-${VentoyVersion}-windows.zip"
$VentoyDir = Join-Path $CacheDir "ventoy-${VentoyVersion}"

# ── Create cache directory ──
if (-not (Test-Path $CacheDir)) {
    New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null
}

# ── List USB devices ──
Write-Host "[INFO] Detected USB devices:" -ForegroundColor Yellow
Write-Host ""
$usbDisks = Get-Disk | Where-Object { $_.BusType -eq "USB" }
if ($usbDisks.Count -eq 0) {
    Write-Host "[ERROR] No USB devices found. Please insert a USB drive and try again." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

$usbDisks | Format-Table Number, FriendlyName, @{
    Label = "Size (GB)"
    Expression = { [math]::Round($_.Size / 1GB, 1) }
}, PartitionStyle -AutoSize

Write-Host ""
Write-Host "[WARNING] Ventoy will FORMAT the selected USB drive!" -ForegroundColor Red
Write-Host "          All data on the drive will be ERASED!" -ForegroundColor Red
Write-Host ""

$confirm = Read-Host "Type YES to continue, or anything else to cancel"
if ($confirm -ne "YES") {
    Write-Host "Cancelled." -ForegroundColor Yellow
    exit 0
}

# ── Download Ventoy ──
if (Test-Path $VentoyZip) {
    Write-Host "[INFO] Ventoy archive already cached, skipping download." -ForegroundColor Green
} else {
    Write-Host "[INFO] Downloading Ventoy v${VentoyVersion}..." -ForegroundColor Yellow
    
    # 检查网络连接
    try {
        $netTest = Test-NetConnection -ComputerName "github.com" -Port 443 -WarningAction SilentlyContinue
        if (-not $netTest.TcpTestSucceeded) {
            Write-Host "[WARN] Network connection to GitHub may be unstable." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "[WARN] Network check failed, continuing anyway..." -ForegroundColor Yellow
    }
    
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue'
        
        # 设置超时和重试
        $retryCount = 0
        $maxRetries = 3
        $downloaded = $false
        
        while ($retryCount -lt $maxRetries -and -not $downloaded) {
            try {
                if ($retryCount -gt 0) {
                    Write-Host "[INFO] Retry $retryCount of $maxRetries..." -ForegroundColor Yellow
                    Start-Sleep -Seconds 2
                }
                
                Invoke-WebRequest -Uri $VentoyUrl -OutFile $VentoyZip -UseBasicParsing -TimeoutSec 30
                $downloaded = $true
                Write-Host "[OK]   Download complete." -ForegroundColor Green
            } catch {
                $retryCount++
                if ($retryCount -eq $maxRetries) {
                    throw $_
                }
            }
        }
    } catch {
        Write-Host "[ERROR] Download failed after $maxRetries attempts: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "        You can manually download from:" -ForegroundColor Yellow
        Write-Host "        https://github.com/ventoy/Ventoy/releases" -ForegroundColor Yellow
        Write-Host "        Save to: $VentoyZip" -ForegroundColor Yellow
        Read-Host "Press Enter to exit"
        exit 1
    }
}

# ── Extract ──
if (-not (Test-Path $VentoyDir)) {
    Write-Host "[INFO] Extracting Ventoy..." -ForegroundColor Yellow
    Expand-Archive -Path $VentoyZip -DestinationPath $CacheDir -Force
    Write-Host "[OK]   Extracted." -ForegroundColor Green
}

# ── Launch Ventoy2Disk ──
$Ventoy2Disk = Join-Path $VentoyDir "Ventoy2Disk.exe"
if (-not (Test-Path $Ventoy2Disk)) {
    Write-Host "[ERROR] Ventoy2Disk.exe not found at $Ventoy2Disk" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "[INFO] Launching Ventoy2Disk GUI..." -ForegroundColor Yellow
Write-Host "       1. Select your USB device in the Ventoy GUI" -ForegroundColor White
Write-Host "       2. Click 'Install' to write Ventoy to the USB" -ForegroundColor White
Write-Host "       3. Wait for completion, then close the GUI" -ForegroundColor White
Write-Host ""

Start-Process -FilePath $Ventoy2Disk -Wait

Write-Host ""
Write-Host "[OK]   Step 1 complete! Your USB drive now has Ventoy." -ForegroundColor Green
Write-Host "       Next: Run .\2-download-iso.ps1" -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter to continue"
