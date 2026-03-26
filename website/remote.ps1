# ============================================================
# M-Claw 远程协助 v3（Windows）
# 用法: irm https://u-claw.org/remote.ps1 | iex
# 改进: SSH 验证、同局域网直连、安全增强、自动超时
# ============================================================

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { chcp 65001 | Out-Null } catch {}
Set-ExecutionPolicy Bypass -Scope Process -Force -ErrorAction SilentlyContinue

Clear-Host
Write-Host ""
Write-Host "  ==========================================" -ForegroundColor Cyan
Write-Host "  M-Claw 远程协助 v3" -ForegroundColor Cyan
Write-Host "  ==========================================" -ForegroundColor Cyan
Write-Host ""

# ---- 安全提示 ----
Write-Host "  ! 本脚本将执行以下操作：" -ForegroundColor Yellow
Write-Host "    1. 开启 SSH 远程登录" -ForegroundColor DarkGray
Write-Host "    2. 建立加密隧道到 M-Claw 中转服务器" -ForegroundColor DarkGray
Write-Host "    3. 技术支持可通过 SSH 连接你的电脑" -ForegroundColor DarkGray
Write-Host "    4. 关闭此窗口即可断开" -ForegroundColor DarkGray
Write-Host ""
$confirm = Read-Host "  是否继续？(y/N)"
if ($confirm -ne "y" -and $confirm -ne "Y") {
    Write-Host "  已取消" -ForegroundColor Red
    exit 0
}
Write-Host ""

# ---- Step 1: SSH ----
Write-Host "  [1/4] 检查 SSH ..." -ForegroundColor White
$sshd = Get-Service sshd -ErrorAction SilentlyContinue
if (-not $sshd) {
    Write-Host "  安装 OpenSSH Server（需要几分钟）..." -ForegroundColor Yellow
    $ErrorActionPreference = "Continue"
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 2>&1 | Out-Null
    $ErrorActionPreference = "Stop"
}
Start-Service sshd -ErrorAction SilentlyContinue
Set-Service -Name sshd -StartupType Automatic -ErrorAction SilentlyContinue

# 开放防火墙
New-NetFirewallRule -Name "OpenSSH-Server-UClaw" -DisplayName "OpenSSH Server (M-Claw)" -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow -ErrorAction SilentlyContinue 2>&1 | Out-Null

# 确保密码认证开启
$sshdConfig = "$env:ProgramData\ssh\sshd_config"
if (Test-Path $sshdConfig) {
    $content = Get-Content $sshdConfig -Raw
    if ($content -match "PasswordAuthentication\s+no") {
        Write-Host "  检测到 SSH 密码登录被禁用，正在开启..." -ForegroundColor Yellow
        $content = $content -replace "PasswordAuthentication\s+no", "PasswordAuthentication yes"
        Set-Content $sshdConfig $content
        Restart-Service sshd -ErrorAction SilentlyContinue
    }
}

# 验证 SSH
$sshd = Get-Service sshd -ErrorAction SilentlyContinue
if ($sshd -and $sshd.Status -eq 'Running') {
    # 再确认端口在监听
    $listening = netstat -an | Select-String ":22\s.*LISTENING"
    if ($listening) {
        Write-Host "  [OK] SSH 已启动并在监听端口 22" -ForegroundColor Green
    } else {
        Write-Host "  [OK] SSH 服务已启动" -ForegroundColor Green
    }
} else {
    Write-Host "  [!] SSH 启动失败" -ForegroundColor Red
    Write-Host "  请确保以管理员身份运行 PowerShell" -ForegroundColor Yellow
    Read-Host "  按回车退出"
    exit 1
}

# ---- Step 2: 检测本地 IP ----
Write-Host ""
Write-Host "  [2/4] 检测网络环境 ..." -ForegroundColor White

$LOCAL_IP = ""
try {
    $adapter = Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Wi-Fi*","Ethernet*","WLAN*" -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike "169.*" -and $_.IPAddress -ne "127.0.0.1" } |
        Select-Object -First 1
    if ($adapter) { $LOCAL_IP = $adapter.IPAddress }
} catch {}

if ($LOCAL_IP) {
    Write-Host "  [OK] 本机局域网 IP: " -ForegroundColor Green -NoNewline
    Write-Host "$LOCAL_IP" -ForegroundColor Cyan
} else {
    Write-Host "  未检测到局域网 IP" -ForegroundColor DarkGray
}

# ---- Step 3: 下载 frpc ----
Write-Host ""
Write-Host "  [3/4] 准备远程通道 ..." -ForegroundColor White

$FRP_DIR = "$env:TEMP\uclaw-frp"
$FRPC = "$FRP_DIR\frpc.exe"

if (-not (Test-Path $FRPC)) {
    New-Item -ItemType Directory -Force -Path $FRP_DIR | Out-Null
    $frpUrl = "https://github.com/fatedier/frp/releases/download/v0.61.1/frp_0.61.1_windows_amd64.zip"
    $frpZip = "$FRP_DIR\frp.zip"

    $mirrors = @(
        "https://ghfast.top/$frpUrl",
        "https://gh-proxy.com/$frpUrl",
        $frpUrl
    )

    $downloaded = $false
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'

    foreach ($url in $mirrors) {
        Write-Host "    下载: $url" -ForegroundColor DarkGray
        try {
            Invoke-WebRequest -Uri $url -OutFile $frpZip -UseBasicParsing -TimeoutSec 60
            if ((Get-Item $frpZip).Length -gt 1MB) { $downloaded = $true; break }
        } catch {
            Write-Host "    失败，换下一个..." -ForegroundColor DarkGray
        }
    }

    if (-not $downloaded) {
        try { & curl.exe -sL $mirrors[0] -o $frpZip; if ((Get-Item $frpZip).Length -gt 1MB) { $downloaded = $true } } catch {}
    }

    if (-not $downloaded) {
        Write-Host "  [!] 下载失败" -ForegroundColor Red
        Read-Host "  按回车退出"
        exit 1
    }

    Expand-Archive $frpZip $FRP_DIR -Force
    $frpcFound = Get-ChildItem -Recurse $FRP_DIR -Filter "frpc.exe" | Select-Object -First 1
    if ($frpcFound) { Copy-Item $frpcFound.FullName $FRPC -Force }
    Remove-Item $frpZip -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path $FRPC)) {
    Write-Host "  [!] frpc 下载失败" -ForegroundColor Red
    Read-Host "  按回车退出"
    exit 1
}

Write-Host "  [OK] 远程通道工具就绪" -ForegroundColor Green

# ---- Step 4: 连接 ----
Write-Host ""
Write-Host "  [4/4] 建立连接 ..." -ForegroundColor White

# 更大的端口范围
$PORT = Get-Random -Minimum 20000 -Maximum 21000
$USERNAME = $env:USERNAME
$COMPUTER = $env:COMPUTERNAME
$SESSION_ID = (Get-Date -Format "HHmm")

$frpcConfig = @"
serverAddr = "101.32.254.221"
serverPort = 2222
auth.method = "token"
auth.token = "uclaw-remote-2026"

[[proxies]]
name = "ssh-$USERNAME-$SESSION_ID-$PORT"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22
remotePort = $PORT
"@
$configPath = "$FRP_DIR\frpc.toml"
[IO.File]::WriteAllText($configPath, $frpcConfig, (New-Object System.Text.UTF8Encoding $false))

Write-Host ""
Write-Host "  ==========================================" -ForegroundColor Green
Write-Host "  OK 远程协助已就绪！" -ForegroundColor Green
Write-Host "  ==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  +------------------------------------------+" -ForegroundColor Yellow
Write-Host "  |  把下面这段发给技术支持（微信）：         |" -ForegroundColor Yellow
Write-Host "  |                                          |" -ForegroundColor Yellow

$portStr = "端口: $PORT"
Write-Host "  |  $portStr$(' ' * (39 - $portStr.Length))|" -ForegroundColor Cyan

$userStr = "用户: $USERNAME"
Write-Host "  |  $userStr$(' ' * (39 - $userStr.Length))|" -ForegroundColor Cyan

$compStr = "电脑: $COMPUTER"
Write-Host "  |  $compStr$(' ' * (39 - $compStr.Length))|" -ForegroundColor Cyan

if ($LOCAL_IP) {
    $lanStr = "局域网: $LOCAL_IP"
    Write-Host "  |  $lanStr$(' ' * (39 - $lanStr.Length))|" -ForegroundColor Cyan
}

Write-Host "  |                                          |" -ForegroundColor Yellow
Write-Host "  +------------------------------------------+" -ForegroundColor Yellow
Write-Host ""

# 局域网直连提示
if ($LOCAL_IP) {
    Write-Host "  > 同一 WiFi 下可直连（更快）:" -ForegroundColor Cyan
    Write-Host "     ssh $USERNAME@$LOCAL_IP" -ForegroundColor White
    Write-Host ""
}

Write-Host "  * 远程通道连接中，断线自动重连" -ForegroundColor DarkGray
Write-Host "  * 关闭此窗口即断开远程" -ForegroundColor DarkGray
Write-Host "  * 连接将在 2 小时后自动断开" -ForegroundColor DarkGray
Write-Host ""

# 启动 frpc（带 2 小时超时）
$frpcProcess = Start-Process -FilePath $FRPC -ArgumentList "-c",$configPath -NoNewWindow -PassThru

# 2 小时超时
$timeout = 7200
$elapsed = 0
while (-not $frpcProcess.HasExited -and $elapsed -lt $timeout) {
    Start-Sleep -Seconds 10
    $elapsed += 10
}

if (-not $frpcProcess.HasExited) {
    Write-Host ""
    Write-Host "  ! 已达 2 小时，自动断开" -ForegroundColor Yellow
    Stop-Process -Id $frpcProcess.Id -Force -ErrorAction SilentlyContinue
}

# 清理配置文件
Remove-Item $configPath -Force -ErrorAction SilentlyContinue
Write-Host "  已安全断开" -ForegroundColor Green
