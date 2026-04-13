# ============================================================
# U-Claw 一键卸载 (Windows PowerShell)
# Usage: irm https://u-claw.org/uninstall.ps1 | iex
# ============================================================

$ErrorActionPreference = "SilentlyContinue"
$UclawDir = "$env:USERPROFILE\.uclaw"
$AgentDir = "$env:TEMP\uclaw"

Write-Host ""
Write-Host "  ==========================================" -ForegroundColor Cyan
Write-Host "    U-Claw 一键卸载" -ForegroundColor Cyan
Write-Host "  ==========================================" -ForegroundColor Cyan
Write-Host ""

# 1. Stop OpenClaw / Node processes in .uclaw
$nodeProcs = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -like "*\.uclaw\*"
}
if ($nodeProcs) {
    Write-Host "  [1/3] 停止 OpenClaw 进程..." -ForegroundColor Yellow
    $nodeProcs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Write-Host "  [OK] 已停止" -ForegroundColor Green
} else {
    Write-Host "  [1/3] OpenClaw 未在运行" -ForegroundColor Gray
}

# 2. Stop Agent
$agentProcs = Get-Process -Name "agent" -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -like "*uclaw*"
}
if ($agentProcs) {
    Write-Host "  [2/3] 停止 Agent 进程..." -ForegroundColor Yellow
    $agentProcs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Write-Host "  [OK] 已停止" -ForegroundColor Green
} else {
    Write-Host "  [2/3] Agent 未在运行" -ForegroundColor Gray
}

# 3. Remove files
Write-Host "  [3/3] 清理文件..." -ForegroundColor Yellow
$removed = $false

if (Test-Path $UclawDir) {
    Remove-Item -Recurse -Force $UclawDir -ErrorAction SilentlyContinue
    Write-Host "  [OK] 已删除 $UclawDir" -ForegroundColor Green
    $removed = $true
}

if (Test-Path $AgentDir) {
    Remove-Item -Recurse -Force $AgentDir -ErrorAction SilentlyContinue
    Write-Host "  [OK] 已删除 $AgentDir" -ForegroundColor Green
    $removed = $true
}

if (-not $removed) {
    Write-Host "  [OK] 没有找到需要清理的文件" -ForegroundColor Gray
}

Write-Host ""
Write-Host "  ==========================================" -ForegroundColor Cyan
Write-Host "    卸载完成！已彻底清理。" -ForegroundColor Green
Write-Host "  ==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  想重装？运行：" -ForegroundColor Gray
Write-Host "  irm https://u-claw.org/install.ps1 | iex" -ForegroundColor White
Write-Host ""
