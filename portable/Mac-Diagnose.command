#!/bin/bash
# ============================================================
# M-Claw Diagnostic Tool - macOS
# 诊断工具
# ============================================================

UCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$UCLAW_DIR/diagnostic-log.txt"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

clear
echo ""
echo "  ========================================"
echo "    M-Claw Diagnostic Tool"
echo "    诊断工具"
echo "  ========================================"
echo ""
echo "  Checking system... 正在检查系统..."
echo ""

# Clear old log
cat > "$LOG_FILE" << EOF
M-Claw Diagnostic Report
Generated: $(date)
========================================

EOF

# 1. Check Node.js
echo "[1/6] Checking Node.js runtime..."
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    NODE_BIN="$UCLAW_DIR/app/runtime/node-mac-arm64/bin/node"
else
    NODE_BIN="$UCLAW_DIR/app/runtime/node-mac-x64/bin/node"
fi

if [ -f "$NODE_BIN" ]; then
    echo "  [OK] Node.js found" >> "$LOG_FILE"
    echo "      Version: $($NODE_BIN --version)" >> "$LOG_FILE"
    echo -e "  ${GREEN}✓${NC} Node.js: Found"
else
    echo "  [ERROR] Node.js not found" >> "$LOG_FILE"
    echo "      Path: $NODE_BIN" >> "$LOG_FILE"
    echo -e "  ${RED}✗${NC} Node.js: NOT FOUND"
fi

# Migration shim: rename old core-mac to core for existing USB users
if [ -d "$UCLAW_DIR/app/core-mac" ] && [ ! -d "$UCLAW_DIR/app/core" ]; then
    mv "$UCLAW_DIR/app/core-mac" "$UCLAW_DIR/app/core"
fi

# 2. Check core directory
echo "[2/6] Checking core directory..."
CORE_DIR="$UCLAW_DIR/app/core"
if [ -d "$CORE_DIR" ]; then
    echo "  [OK] core directory exists" >> "$LOG_FILE"
    echo -e "  ${GREEN}✓${NC} core: Found"
else
    echo "  [ERROR] core directory not found" >> "$LOG_FILE"
    echo -e "  ${RED}✗${NC} core: NOT FOUND"
fi

# 3. Check node_modules
echo "[3/6] Checking dependencies..."
if [ -d "$CORE_DIR/node_modules" ]; then
    echo "  [OK] node_modules exists" >> "$LOG_FILE"
    echo -e "  ${GREEN}✓${NC} Dependencies: Found"
else
    echo "  [ERROR] node_modules not found" >> "$LOG_FILE"
    echo -e "  ${RED}✗${NC} Dependencies: NOT FOUND"
fi

# 4. Check OpenClaw
echo "[4/6] Checking OpenClaw..."
OPENCLAW_MJS="$CORE_DIR/node_modules/openclaw/openclaw.mjs"
if [ -f "$OPENCLAW_MJS" ]; then
    echo "  [OK] openclaw.mjs found" >> "$LOG_FILE"
    echo -e "  ${GREEN}✓${NC} OpenClaw: Found"
else
    echo "  [ERROR] openclaw.mjs not found" >> "$LOG_FILE"
    echo "      Path: $OPENCLAW_MJS" >> "$LOG_FILE"
    echo -e "  ${RED}✗${NC} OpenClaw: NOT FOUND"
fi

# 5. Check port availability
echo "[5/6] Checking port 18789..."
if lsof -i:18789 >/dev/null 2>&1; then
    echo "  [WARNING] Port 18789 is in use" >> "$LOG_FILE"
    lsof -i:18789 >> "$LOG_FILE" 2>&1
    echo -e "  ${YELLOW}⚠${NC} Port 18789: IN USE"
else
    echo "  [OK] Port 18789 is available" >> "$LOG_FILE"
    echo -e "  ${GREEN}✓${NC} Port 18789: Available"
fi

# 6. Test OpenClaw startup
echo "[6/6] Testing OpenClaw startup..."
echo "" >> "$LOG_FILE"
echo "Testing OpenClaw startup:" >> "$LOG_FILE"
echo "----------------------------------------" >> "$LOG_FILE"

export OPENCLAW_HOME="$UCLAW_DIR/data"
export OPENCLAW_STATE_DIR="$UCLAW_DIR/data/.openclaw"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"

if [ -f "$NODE_BIN" ] && [ -f "$OPENCLAW_MJS" ]; then
    cd "$CORE_DIR"
    "$NODE_BIN" "$OPENCLAW_MJS" --version >> "$LOG_FILE" 2>&1
    if [ $? -eq 0 ]; then
        echo -e "  ${GREEN}✓${NC} OpenClaw: Can run"
    else
        echo -e "  ${RED}✗${NC} OpenClaw: Failed to run"
        echo "  [ERROR] OpenClaw failed to start" >> "$LOG_FILE"
    fi
else
    echo -e "  ${RED}✗${NC} Cannot test - files missing"
    echo "  [SKIP] Cannot test - required files missing" >> "$LOG_FILE"
fi

echo ""
echo "" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"
echo "Diagnostic complete." >> "$LOG_FILE"

echo "  ========================================"
echo "    Diagnostic Complete"
echo "  ========================================"
echo ""
echo "  Log saved to: diagnostic-log.txt"
echo ""
echo "  Next steps:"
echo "  1. Check diagnostic-log.txt for details"
echo "  2. If errors found, try running Mac-Start.command"
echo "     to auto-install missing dependencies"
echo ""
read -p "  Press Enter to exit..."
