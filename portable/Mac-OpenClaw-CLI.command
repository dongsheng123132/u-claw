#!/bin/bash
# ============================================================
# U-Claw - Interactive CLI (macOS)
# Double-click to open terminal with openclaw command
# ============================================================

UCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$UCLAW_DIR/app"
CORE_DIR="$APP_DIR/core"
DATA_DIR="$UCLAW_DIR/data"
STATE_DIR="$DATA_DIR/.openclaw"
CONFIG_FILE="$STATE_DIR/openclaw.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}   U-Claw Interactive CLI${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# Detect CPU & set runtime
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    NODE_DIR="$APP_DIR/runtime/node-mac-arm64"
elif [ "$ARCH" = "x86_64" ]; then
    NODE_DIR="$APP_DIR/runtime/node-mac-x64"
else
    echo -e "  ${RED}Unsupported architecture: $ARCH${NC}"
    exit 1
fi

NODE_BIN="$NODE_DIR/bin/node"

if [ ! -f "$NODE_BIN" ]; then
    echo -e "  ${RED}[ERROR] Node.js runtime not found${NC}"
    echo -e "  ${YELLOW}Please run setup.sh first${NC}"
    echo ""
    read -p "  Press Enter to exit..."
    exit 1
fi

# Set environment
export OPENCLAW_HOME="$DATA_DIR"
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$CONFIG_FILE"
export PATH="$NODE_DIR/bin:$PATH"

OPENCLAW_MJS="$CORE_DIR/node_modules/openclaw/openclaw.mjs"

echo -e "  ${GREEN}Node.js:${NC} $("$NODE_BIN" --version)"
echo -e "  ${GREEN}OpenClaw CLI ready${NC}"
echo ""
echo -e "  Examples:"
echo -e "    ${CYAN}openclaw --help${NC}"
echo -e "    ${CYAN}openclaw ask \"Hello\"${NC}"
echo -e "    ${CYAN}openclaw --skill word-writer \"Write a report\"${NC}"
echo -e "    ${CYAN}openclaw dashboard${NC}"
echo -e "    ${CYAN}openclaw configure${NC}"
echo ""
echo -e "${CYAN}========================================${NC}"
echo ""

# Keep terminal open and run interactive shell
$SHELL
