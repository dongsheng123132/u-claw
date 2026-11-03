#!/bin/bash
# Keep trying to put the filesystem-gate files onto the customer stick.
# Relays and sshd on that box flap; when a channel answers, apply and stop.
set -u
RA=~/claude/远程无头运维工具cli/build/remote-agent
export NO_PROXY="47.107.130.152,127.0.0.1"
export HTTP_PROXY="" HTTPS_PROXY="" http_proxy="" https_proxy=""
export REMOTE_AGENT_SERVER='wss://47.107.130.152:8900'
export REMOTE_AGENT_TOKEN='27b6eb9a0a37217fd8545f5c0208cda1'

read -r -d '' PS <<'PS1'
$ErrorActionPreference='Continue'
$stick = 'E:\u-claw-portable-windows-v2.5.0-rc1'
$o = @()
function L($m){ $script:o += [string]$m }
$v = [guid]::NewGuid().ToString('N')
$files = @(
  @{ u='portable/Windows-Start.bat';        d=(Join-Path $stick 'Windows-Start.bat') },
  @{ u='portable/lib/engine-host.ps1';      d=(Join-Path $stick 'lib\engine-host.ps1') },
  @{ u='portable/lib/portable-cache.mjs';   d=(Join-Path $stick 'lib\portable-cache.mjs') }
)
foreach ($f in $files) {
  $url = 'https://raw.githubusercontent.com/dongsheng123132/u-claw/main/' + $f.u + '?v=' + $v
  & curl.exe -sL --max-time 90 -o $f.d $url
  if (Test-Path $f.d) { L ((Split-Path $f.d -Leaf) + '=' + (Get-Item $f.d).Length) }
}
$bat = [IO.File]::ReadAllText((Join-Path $stick 'Windows-Start.bat'), [Text.Encoding]::ASCII)
L ('gate_in_bat=' + [bool]($bat -match 'UCLAW_FS_COMPAT'))
$ps  = [IO.File]::ReadAllText((Join-Path $stick 'lib\engine-host.ps1'), [Text.Encoding]::ASCII)
L ('fs_in_resolver=' + [bool]($ps -match 'UCLAW_STICK_FS'))
$pc  = [IO.File]::ReadAllText((Join-Path $stick 'lib\portable-cache.mjs'), [Text.Encoding]::UTF8)
L ('compat_in_cache=' + [bool]($pc -match 'UCLAW_FS_COMPAT'))
($o -join ' ;; ')
PS1

B64=$(printf '%s' "$PS" | base64 | tr -d '\n')

for i in $(seq 1 120); do
  echo "[$(date +%H:%M:%S)] attempt $i"
  out=$($RA exec pc-3116 "powershell -NoProfile -EncodedCommand $B64" 2>&1 | tail -2)
  if echo "$out" | grep -q 'gate_in_bat'; then
    echo "$out" | tr ';' '\n' | grep -a -E '\.bat=|\.ps1=|\.mjs=|gate_in_bat|fs_in_resolver|compat_in_cache'
    echo "APPLIED"; exit 0
  fi
  sleep 45
done
echo "GAVE_UP"
exit 1
