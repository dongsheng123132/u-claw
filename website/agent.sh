#!/bin/bash
# ============================================================
# U-Claw Remote Agent (macOS / Linux)
# Usage: curl -fsSL https://u-claw.org/agent.sh | bash
# ============================================================

set -e

RELAY_SERVER="wss://47.107.130.152:8900"
TOKEN="uclaw-agent-pub"
TIMEOUT_HOURS=2
AGENT_DIR="/tmp/uclaw"
AGENT_PATH="$AGENT_DIR/agent"

# Detect OS
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$OS" in
    darwin)  DOWNLOAD_URL="https://u-claw.org/downloads/agent" ;;
    linux)   DOWNLOAD_URL="https://u-claw.org/downloads/agent-linux" ;;
    *)       echo "  [FAIL] Unsupported OS: $OS"; exit 1 ;;
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
read -r confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "  Cancelled."
    exit 0
fi
echo ""

# Download agent
echo "  [1/2] Downloading agent..."
mkdir -p "$AGENT_DIR"
if command -v curl &>/dev/null; then
    curl -fsSL -o "$AGENT_PATH" "$DOWNLOAD_URL"
elif command -v wget &>/dev/null; then
    wget -q -O "$AGENT_PATH" "$DOWNLOAD_URL"
else
    echo "  [FAIL] Neither curl nor wget found"
    exit 1
fi
chmod +x "$AGENT_PATH"
echo "  [OK] Download complete"

# Cleanup on exit
cleanup() {
    echo ""
    echo "  Disconnected."
    rm -rf "$AGENT_DIR" 2>/dev/null
    exit 0
}
trap cleanup INT TERM EXIT

# Run agent
echo "  [2/2] Connecting..."
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

# Run with timeout
timeout "${TIMEOUT_HOURS}h" "$AGENT_PATH" \
    -server "$RELAY_SERVER" \
    -token "$TOKEN" \
    -id "$DEVICE_ID" 2>/dev/null || true
