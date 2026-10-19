#!/bin/bash
# ============================================================
# U-Claw - Interactive CLI (macOS)
# 进阶用户：双击打开一个配置好环境的终端，可直接敲 openclaw 命令。
# 复用与 Mac-Start.command 一致的便携环境（盘内 Node + 盘内数据）。
# ============================================================

UCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$UCLAW_DIR/app"
CORE_DIR="$APP_DIR/core"
DATA_DIR="$UCLAW_DIR/data"
STATE_DIR="$DATA_DIR/.openclaw"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'

# Detect CPU & set runtime（与 Mac-Start.command 一致）
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    NODE_DIR="$APP_DIR/runtime/node-mac-arm64"
elif [ "$ARCH" = "x86_64" ]; then
    NODE_DIR="$APP_DIR/runtime/node-mac-x64"
else
    echo -e "  ${RED}Unsupported architecture: $ARCH${NC}"
    read -p "  Press Enter to exit..."
    exit 1
fi

NODE_BIN="$NODE_DIR/bin/node"
if [ ! -f "$NODE_BIN" ]; then
    echo -e "  ${RED}Node.js runtime not found.${NC} Run Mac-Start.command once first."
    read -p "  Press Enter to exit..."
    exit 1
fi
if [ ! -x "$CORE_DIR/node_modules/.bin/openclaw" ]; then
    echo -e "  ${RED}OpenClaw not installed yet.${NC} Run Mac-Start.command once first."
    read -p "  Press Enter to exit..."
    exit 1
fi

# 本机缓存/临时/日志目录（共享 helper）；没有可写本机缓存 = 明确失败退出。
if ! . "$UCLAW_DIR/lib/portable-cache-env.sh" "$STATE_DIR" "$UCLAW_DIR" "$NODE_BIN"; then
    echo -e "  ${RED}无可写本机缓存目录，拒绝回落 U 盘。${NC}"
    read -p "  Press Enter to exit..."
    exit 1
fi

export OPENCLAW_HOME="$DATA_DIR"
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$STATE_DIR/openclaw.json"
# 盘内 node 和 .bin 放到 PATH 最前，让 openclaw 命令可直接调用
export PATH="$NODE_DIR/bin:$CORE_DIR/node_modules/.bin:$PATH"

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}   U-Claw Interactive CLI${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""
echo "  You can now run the 'openclaw' command directly. Examples:"
echo "    openclaw --help          Show all commands"
echo "    openclaw chat            Open the terminal chat UI"
echo "    openclaw configure       Interactive setup (models, channels)"
echo "    openclaw doctor          Diagnose and repair"
echo "    openclaw gateway status  Check the running gateway"
echo ""
echo -e "  Type ${GREEN}exit${NC} to close."
echo -e "${CYAN}========================================${NC}"
echo ""

# 开一个继承上述环境的交互 shell
exec "$SHELL" -i
