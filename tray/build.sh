#!/usr/bin/env bash
# Build U-Claw-Tray.exe for Windows x64.
# Pure Go + github.com/getlantern/systray (its Windows backend is syscall-only:
# no CGO, no C toolchain, no WebView2 runtime, no browser bundle).
#
# Usage:  cd tray && ./build.sh      ->  tray/build/U-Claw-Tray.exe
# China mirrors (only if the default proxy is slow / blocked):
#   export GOPROXY=https://goproxy.cn,direct
#   # or: export https_proxy=http://127.0.0.1:7897
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p build
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w -H windowsgui" -o build/U-Claw-Tray.exe .
echo "built: $(pwd)/build/U-Claw-Tray.exe ($(wc -c < build/U-Claw-Tray.exe | tr -d ' ') bytes)"
