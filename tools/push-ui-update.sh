#!/bin/bash
# Watch for the pc-3116 channel (SSH first, relay second), then:
#   1. stop any running U-Claw instance from the RC folder (so files are not locked)
#   2. refresh the two changed UI/launcher files from GitHub raw
#   3. prove it by printing the file sizes and the wallet copy
set -u
RA=~/claude/远程无头运维工具cli/build/remote-agent
export NO_PROXY="47.107.130.152,127.0.0.1"
export HTTP_PROXY="" HTTPS_PROXY="" http_proxy="" https_proxy=""
export REMOTE_AGENT_SERVER='wss://47.107.130.152:8900'
export REMOTE_AGENT_TOKEN='27b6eb9a0a37217fd8545f5c0208cda1'

STICK='E:\u-claw-portable-windows-v2.5.0-rc1'
RAW='https://raw.githubusercontent.com/dongsheng123132/u-claw/main/portable'

PS=$(cat <<'PS1'
$ErrorActionPreference='Continue'
$stick = 'E:\u-claw-portable-windows-v2.5.0-rc1'
$log = 'E:\uclaw-ui-update.log'
function W($m){ ("[" + (Get-Date -Format 'HH:mm:ss') + "] " + $m) | Out-File -FilePath $log -Append -Encoding utf8 }
"start" | Out-File -FilePath $log -Encoding utf8

# 1) stop U-Claw instances started from this folder so the files are not locked
$killed = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='cmd.exe' or Name='powershell.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*u-claw-portable-windows-v2.5.0-rc1*' -and $_.ProcessId -ne $PID } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $killed++ } catch {} }
W ("stopped=" + $killed)

# 2) refresh the changed files
$files = @(
  @{ url = 'https://raw.githubusercontent.com/dongsheng123132/u-claw/main/portable/config-server/public/index.html';
     dst = Join-Path $stick 'config-server\public\index.html' },
  @{ url = 'https://raw.githubusercontent.com/dongsheng123132/u-claw/main/portable/Windows-Start.bat';
     dst = Join-Path $stick 'Windows-Start.bat' }
)
foreach ($f in $files) {
  & curl.exe -sL --max-time 120 -o $f.dst $f.url
  if (Test-Path $f.dst) { W ((Split-Path $f.dst -Leaf) + '=' + (Get-Item $f.dst).Length) } else { W ((Split-Path $f.dst -Leaf) + ' MISSING') }
}
$idx = Join-Path $stick 'config-server\public\index.html'
if (Test-Path $idx) {
  $raw = Get-Content $idx -Raw
  W ('wallet_card=' + ($raw -match '领取免费额度并开始'))
  W ('topup_btn=' + ($raw -match '去充值'))
  W ('steps=' + ($raw -match 'wallet-steps'))
}
W 'DONE'
PS1
)

run_ps_via_ssh() {
  printf '%s' "$PS" | base64 | tr -d '\n'
}

try_ssh() {
  ssh -T -o BatchMode=yes -o ConnectTimeout=6 zjzhfs "echo PING" 2>/dev/null | grep -qa PING || return 1
  B64=$(run_ps_via_ssh)
  ssh -T -o BatchMode=yes -o ConnectTimeout=10 zjzhfs "powershell -NoProfile -Command \"[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$B64')) | Out-File -Encoding utf8 D:\\ui-update.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File D:\\ui-update.ps1; 'APPLIED'\"" 2>&1 | tail -3
  return 0
}

try_relay() {
  $RA exec pc-3116 "echo R" 2>/dev/null | grep -qa '^R' || return 1
  B64=$(run_ps_via_ssh)
  $RA exec pc-3116 "powershell -NoProfile -Command \"[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$B64')) | Out-File -Encoding utf8 D:\\ui-update.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File D:\\ui-update.ps1; 'APPLIED'\"" 2>&1 | tail -3
  return 0
}

for i in $(seq 1 120); do
  echo "[$(date +%H:%M:%S)] attempt $i"
  if try_ssh; then echo "APPLIED_VIA_SSH"; exit 0; fi
  if try_relay; then echo "APPLIED_VIA_RELAY"; exit 0; fi
  sleep 30
done
echo "GAVE_UP"
exit 1
