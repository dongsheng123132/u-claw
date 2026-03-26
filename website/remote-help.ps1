# ============================================================
# M-Claw 远程协助 (Windows)
# 用法: irm https://u-claw.org/remote-help.ps1 | iex
# ============================================================

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
try { chcp 65001 | Out-Null } catch {}
Set-ExecutionPolicy Bypass -Scope Process -Force -ErrorAction SilentlyContinue

Clear-Host
Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "  M-Claw 远程协助 - 一键开启" -ForegroundColor Cyan
Write-Host "  技术支持将通过 SSH 帮你安装/调试" -ForegroundColor Cyan
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""

# ---- Step 1: 安装并启动 SSH ----
Write-Host "  [1/3] 检查 SSH 服务 ..." -ForegroundColor White

$sshdService = Get-Service sshd -ErrorAction SilentlyContinue
if (-not $sshdService) {
    Write-Host "  正在安装 OpenSSH Server（需要几分钟）..." -ForegroundColor Yellow
    $ErrorActionPreference = "Continue"
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 2>&1 | Out-Null
    $ErrorActionPreference = "Stop"
}

# 启动 SSH
Start-Service sshd -ErrorAction SilentlyContinue
Set-Service -Name sshd -StartupType Automatic -ErrorAction SilentlyContinue

# 验证
$sshdService = Get-Service sshd -ErrorAction SilentlyContinue
if ($sshdService -and $sshdService.Status -eq 'Running') {
    Write-Host "  [OK] SSH 服务已启动" -ForegroundColor Green
} else {
    Write-Host "  [!] SSH 启动失败，尝试备用方案..." -ForegroundColor Red
    # 尝试重新启动
    try {
        Start-Service sshd
        Write-Host "  [OK] SSH 服务已启动" -ForegroundColor Green
    } catch {
        Write-Host "  [!] SSH 安装失败，请以管理员身份运行 PowerShell" -ForegroundColor Red
        Write-Host "  右键开始菜单 → '终端(管理员)' → 重新运行本命令" -ForegroundColor Yellow
        Read-Host "  按回车退出"
        exit 1
    }
}

Write-Host ""

# ---- Step 2: 防火墙放行 ----
Write-Host "  [2/3] 配置防火墙 ..." -ForegroundColor White
$ErrorActionPreference = "Continue"
New-NetFirewallRule -Name "OpenSSH-Server" -DisplayName "OpenSSH Server" -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow -ErrorAction SilentlyContinue 2>&1 | Out-Null
$ErrorActionPreference = "Stop"
Write-Host "  [OK] 防火墙已放行 SSH" -ForegroundColor Green
Write-Host ""

# ---- Step 3: 开启隧道 ----
Write-Host "  [3/3] 开启远程通道 ..." -ForegroundColor White

$BORE_DIR = "$env:TEMP\uclaw-remote"
$BORE_EXE = "$BORE_DIR\bore.exe"

if (-not (Test-Path $BORE_EXE)) {
    New-Item -ItemType Directory -Force -Path $BORE_DIR | Out-Null
    $boreUrl = "https://github.com/ekzhang/bore/releases/download/v0.5.2/bore-v0.5.2-x86_64-pc-windows-msvc.zip"
    $boreZip = "$BORE_DIR\bore.zip"

    Write-Host "  下载隧道工具..." -ForegroundColor Yellow
    $ErrorActionPreference = "Continue"
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $boreUrl -OutFile $boreZip -UseBasicParsing
    } catch {
        # 备用: 用 curl
        try {
            & curl.exe -sL $boreUrl -o $boreZip
        } catch {
            Write-Host "  [!] 下载失败，请检查网络（需要能访问 GitHub）" -ForegroundColor Red
            Read-Host "  按回车退出"
            exit 1
        }
    }
    $ErrorActionPreference = "Stop"

    Expand-Archive -Path $boreZip -DestinationPath $BORE_DIR -Force
    Remove-Item $boreZip -ErrorAction SilentlyContinue
}

if (-not (Test-Path $BORE_EXE)) {
    Write-Host "  [!] 隧道工具下载失败" -ForegroundColor Red
    Read-Host "  按回车退出"
    exit 1
}

# 获取用户信息
$USERNAME = $env:USERNAME
$COMPUTERNAME = $env:COMPUTERNAME

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Green
Write-Host "  远程协助已就绪！" -ForegroundColor Green
Write-Host "  ============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  你的用户名: $USERNAME" -ForegroundColor White
Write-Host "  你的电脑名: $COMPUTERNAME" -ForegroundColor White
Write-Host ""
Write-Host "  正在开启远程通道..." -ForegroundColor Yellow
Write-Host "  开启后，把下面显示的连接信息发给技术支持" -ForegroundColor Yellow
Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "  提示: 关闭此窗口即可断开远程连接" -ForegroundColor DarkGray
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""

# 启动 bore 隧道（会阻塞，显示端口号）
& $BORE_EXE local 22 --to bore.pub
