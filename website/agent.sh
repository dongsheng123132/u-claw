#!/bin/bash
# ============================================================
# U-Claw Remote Agent (macOS / Linux)
# Usage:
#   Install & run:  curl -fsSL https://u-claw.org/agent.sh | bash
#   Uninstall:      curl -fsSL https://u-claw.org/agent.sh | bash -s -- --uninstall
# ============================================================

set -e

RELAY_SERVER="wss://47.107.130.152:8900"
TOKEN="uclaw-agent-pub"
TIMEOUT_HOURS=2
AGENT_DIR="/tmp/uclaw"
AGENT_PATH="$AGENT_DIR/agent"

# ---- Uninstall mode ----
if [ "${1:-}" = "--uninstall" ]; then
    echo ""
    echo "  =========================================="
    echo "    U-Claw Agent — Uninstall"
    echo "  =========================================="
    echo ""
    # Kill running agent processes
    if pgrep -f "$AGENT_PATH" >/dev/null 2>&1; then
        echo "  [1/2] Stopping running agent..."
        pkill -f "$AGENT_PATH" 2>/dev/null || true
        sleep 1
        echo "  [OK] Agent stopped"
    else
        echo "  [1/2] No running agent found"
    fi
    # Remove files
    if [ -d "$AGENT_DIR" ]; then
        echo "  [2/2] Removing $AGENT_DIR ..."
        rm -rf "$AGENT_DIR"
        echo "  [OK] Removed"
    else
        echo "  [2/2] Nothing to remove ($AGENT_DIR not found)"
    fi
    echo ""
    echo "  Uninstall complete. All clean!"
    echo ""
    exit 0
fi

# ---- Detect OS & architecture ----
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
    darwin)
        case "$ARCH" in
            arm64|aarch64) DOWNLOAD_URL="http://47.107.130.152/downloads/agent" ;;
            x86_64|amd64)  DOWNLOAD_URL="http://47.107.130.152/downloads/agent-mac-intel" ;;
            *)             echo "  [FAIL] Unsupported Mac architecture: $ARCH"; exit 1 ;;
        esac
        ;;
    linux)
        DOWNLOAD_URL="http://47.107.130.152/downloads/agent-linux"
        ;;
    *)
        echo "  [FAIL] Unsupported OS: $OS"; exit 1
        ;;
esac

# Generate device ID
HOSTNAME_SHORT=$(hostname -s 2>/dev/null || hostname | cut -d. -f1)
HOSTNAME_LOWER=$(echo "$HOSTNAME_SHORT" | tr '[:upper:]' '[:lower:]')
RAND=$(cat /dev/urandom | LC_ALL=C tr -dc 'a-z0-9' | head -c 4)
DEVICE_ID="${HOSTNAME_LOWER}-${RAND}"

clear
echo ""
echo "  =========================================="
echo "    U-Claw Remote Agent"
echo "  =========================================="
echo ""
echo "  ! This script will:"
echo "    1. Download a lightweight remote agent (~8MB)"
echo "    2. Connect to U-Claw relay server"
echo "    3. Allow remote command execution for support"
echo "    4. Press Ctrl+C or close terminal to disconnect"
echo ""
printf "  Continue? (y/N) "
if read -r confirm < /dev/tty 2>/dev/null; then
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        echo "  Cancelled."
        exit 0
    fi
else
    echo "y (auto)"
fi
echo ""

# Download agent
echo "  [1/3] Downloading agent..."
mkdir -p "$AGENT_DIR"
if command -v curl &>/dev/null; then
    curl -fsSL --connect-timeout 15 --max-time 120 -o "$AGENT_PATH" "$DOWNLOAD_URL"
elif command -v wget &>/dev/null; then
    wget -q --timeout=120 -O "$AGENT_PATH" "$DOWNLOAD_URL"
else
    echo "  [FAIL] Neither curl nor wget found"
    exit 1
fi

if [ ! -f "$AGENT_PATH" ] || [ ! -s "$AGENT_PATH" ]; then
    echo "  [FAIL] Download failed or file is empty"
    echo "  Please check your network connection and try again."
    exit 1
fi

chmod +x "$AGENT_PATH"
echo "  [OK] Download complete"

# macOS: remove quarantine attribute to bypass Gatekeeper
if [ "$OS" = "darwin" ]; then
    echo "  [2/3] Removing macOS Gatekeeper quarantine..."
    xattr -d com.apple.quarantine "$AGENT_PATH" 2>/dev/null || true
    echo "  [OK] Gatekeeper bypass applied"
else
    echo "  [2/3] Skipping (not macOS)"
fi

# Cleanup on exit
cleanup() {
    echo ""
    echo "  Disconnected."
    rm -rf "$AGENT_DIR" 2>/dev/null
    exit 0
}
trap cleanup INT TERM EXIT

# Run agent
echo "  [3/3] Connecting..."
echo ""
echo "  =========================================="
echo "    Connected! Send this ID to support:"
echo "  =========================================="
echo ""
echo "  +------------------------------------------+"
echo "  |  Device ID:  $DEVICE_ID"
echo "  |  Hostname:   $(hostname)"
echo "  +------------------------------------------+"
echo ""
echo "  * Press Ctrl+C or close terminal to disconnect"
echo "  * Auto-disconnect after ${TIMEOUT_HOURS} hours"
echo ""

# Run with timeout (macOS may not have GNU timeout)
run_with_timeout() {
    if command -v timeout &>/dev/null; then
        timeout "${TIMEOUT_HOURS}h" "$@"
    elif command -v gtimeout &>/dev/null; then
        gtimeout "${TIMEOUT_HOURS}h" "$@"
    else
        # Fallback: use perl alarm for timeout
        local secs=$((TIMEOUT_HOURS * 3600))
        perl -e "alarm $secs; exec @ARGV" -- "$@"
    fi
}

run_with_timeout "$AGENT_PATH" \
    -server "$RELAY_SERVER" \
    -token "$TOKEN" \
    -id "$DEVICE_ID" 2>/dev/null || true
