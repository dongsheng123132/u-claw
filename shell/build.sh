#!/usr/bin/env bash
# Build the optional WebView2 shell for Windows x64.
# Pure Go + system WebView2 runtime; no CGO, no browser bundle.
set -euo pipefail
cd "$(dirname "$0")"
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags='-s -w -H windowsgui' -o U-Claw-Shell.exe .
