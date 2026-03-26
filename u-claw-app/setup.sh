#!/bin/bash
# ============================================================
# M-Claw Desktop App - One-click Setup (Mac/Linux)
# 克隆后运行此脚本，自动配置开发环境
# ============================================================

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'
BOLD='\033[1m'

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_VER="v22.16.0"
MIRROR="https://registry.npmmirror.com"
NODE_MIRROR="https://npmmirror.com/mirrors/node"

clear
echo ""
echo -e "${CYAN}${BOLD}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║   M-Claw Desktop App Setup           ║"
echo "  ║   一键安装开发环境                    ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"

# ---- 1. Check / Install Node.js ----
echo -e "  ${BOLD}[1/4] 检查 Node.js...${NC}"

# Check system node first
SYS_NODE=$(which node 2>/dev/null || true)
if [ -n "$SYS_NODE" ]; then
    SYS_VER=$("$SYS_NODE" --version 2>/dev/null || echo "")
    MAJOR=$(echo "$SYS_VER" | sed 's/v//' | cut -d. -f1)
    if [ "$MAJOR" -ge 20 ] 2>/dev/null; then
        echo -e "  ${GREEN}系统 Node.js $SYS_VER ✓${NC}"
        NODE_BIN="$SYS_NODE"
    fi
fi

# If no suitable system node, download portable one
if [ -z "$NODE_BIN" ]; then
    ARCH=$(uname -m)
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')

    if [ "$OS" = "darwin" ]; then
        if [ "$ARCH" = "arm64" ]; then
            PLATFORM="darwin-arm64"
        else
            PLATFORM="darwin-x64"
        fi
    elif [ "$OS" = "linux" ]; then
        PLATFORM="linux-x64"
    else
        echo -e "  ${RED}不支持的系统: $OS${NC}"
        exit 1
    fi

    RUNTIME_DIR="$APP_DIR/resources/runtime/node-${OS}-${ARCH}"
    NODE_BIN_PATH="$RUNTIME_DIR/bin/node"

    if [ -f "$NODE_BIN_PATH" ]; then
        echo -e "  ${GREEN}已有 Node.js runtime ✓${NC}"
        NODE_BIN="$NODE_BIN_PATH"
    else
        echo -e "  ${YELLOW}下载 Node.js $NODE_VER ($PLATFORM)...${NC}"
        echo -e "  ${CYAN}镜像: npmmirror.com${NC}"

        TARBALL="node-${NODE_VER}-${PLATFORM}.tar.gz"
        URL="${NODE_MIRROR}/${NODE_VER}/${TARBALL}"

        mkdir -p "$RUNTIME_DIR"
        curl -# -L "$URL" -o "/tmp/$TARBALL"
        tar -xzf "/tmp/$TARBALL" -C "$RUNTIME_DIR" --strip-components=1
        rm -f "/tmp/$TARBALL"

        chmod +x "$RUNTIME_DIR/bin/node"
        NODE_BIN="$NODE_BIN_PATH"
        echo -e "  ${GREEN}Node.js $NODE_VER 下载完成 ✓${NC}"
    fi

    export PATH="$(dirname "$NODE_BIN"):$PATH"
fi

echo -e "  Node: ${GREEN}$("$NODE_BIN" --version)${NC}"
echo ""

# ---- 2. Install npm dependencies ----
echo -e "  ${BOLD}[2/4] 安装依赖 (国内镜像)...${NC}"
echo -e "  ${CYAN}镜像: $MIRROR${NC}"
echo ""

cd "$APP_DIR"

# Set electron mirror for China
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"

npm install --registry="$MIRROR" 2>&1 | tail -5
echo ""
echo -e "  ${GREEN}依赖安装完成 ✓${NC}"
echo ""

# ---- 3. Download Node.js runtime for packaging ----
echo -e "  ${BOLD}[3/4] 准备打包用 Node.js runtime...${NC}"

# For packaging, we need the runtime in resources/ for the target platform
ARCH=$(uname -m)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
RUNTIME_DIR="$APP_DIR/resources/runtime/node-${OS}-${ARCH}"

if [ -f "$RUNTIME_DIR/bin/node" ]; then
    echo -e "  ${GREEN}Runtime 已就绪 ✓${NC}"
else
    PLATFORM="${OS}-${ARCH}"
    [ "$OS" = "darwin" ] && [ "$ARCH" = "x86_64" ] && PLATFORM="darwin-x64"

    echo -e "  ${YELLOW}下载 Node.js $NODE_VER runtime ($PLATFORM)...${NC}"
    TARBALL="node-${NODE_VER}-${PLATFORM}.tar.gz"
    URL="${NODE_MIRROR}/${NODE_VER}/${TARBALL}"

    mkdir -p "$RUNTIME_DIR"
    curl -# -L "$URL" -o "/tmp/$TARBALL"
    tar -xzf "/tmp/$TARBALL" -C "$RUNTIME_DIR" --strip-components=1
    rm -f "/tmp/$TARBALL"
    chmod +x "$RUNTIME_DIR/bin/node"
    echo -e "  ${GREEN}Runtime 下载完成 ✓${NC}"
fi
echo ""

# ---- 4. Done ----
echo -e "  ${BOLD}[4/4] 完成！${NC}"
echo ""
echo -e "  ${GREEN}${BOLD}╔══════════════════════════════════════╗"
echo -e "  ║   ✅ 安装成功！                       ║"
echo -e "  ╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}接下来你可以:${NC}"
echo ""
echo -e "  ${CYAN}运行开发版:${NC}"
echo -e "    cd u-claw-app"
echo -e "    npm run dev"
echo ""
echo -e "  ${CYAN}打包 DMG (Mac):${NC}"
echo -e "    npm run build:mac-arm64    # Apple Silicon"
echo -e "    npm run build:mac-x64      # Intel Mac"
echo ""
echo -e "  ${CYAN}打包 EXE (Windows, 需在 Windows 上运行):${NC}"
echo -e "    npm run build:win"
echo ""
echo -e "  产出在 ${BOLD}release/${NC} 目录"
echo ""

# Ask if user wants to run now
if [ -t 0 ]; then
    read -p "  现在启动开发版？(y/n): " -n 1 RUN
    echo ""
    if [ "$RUN" = "y" ] || [ "$RUN" = "Y" ]; then
        echo ""
        echo -e "  ${CYAN}启动 M-Claw...${NC}"
        npm run dev
    fi
fi
