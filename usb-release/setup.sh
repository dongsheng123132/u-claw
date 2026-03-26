#!/bin/bash
# ============================================================
# M-Claw — 开发环境搭建脚本
# 用法: bash setup.sh [--all-platforms] [--with-toolkit]
# 作用: 下载 Node.js 运行时 + 安装 OpenClaw 到 core/
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORE_DIR="$SCRIPT_DIR/core"
RUNTIME_DIR="$SCRIPT_DIR/runtime"
MIRROR="https://registry.npmmirror.com"
NODE_MIRROR="https://npmmirror.com/mirrors/node"
NODE_VERSION="v22.14.0"
ALL_PLATFORMS=false
WITH_TOOLKIT=false

for arg in "$@"; do
    [ "$arg" = "--all-platforms" ] && ALL_PLATFORMS=true
    [ "$arg" = "--with-toolkit" ] && WITH_TOOLKIT=true
done

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  🦞 M-Claw Setup                    ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

# ---- Detect OS & Arch ----
OS=$(uname -s)
ARCH=$(uname -m)

if [ "$OS" = "Darwin" ]; then
    if [ "$ARCH" = "arm64" ]; then
        PLATFORM="darwin-arm64"
        NODE_DIR_NAME="node-mac-arm64"
    else
        PLATFORM="darwin-x64"
        NODE_DIR_NAME="node-mac-x64"
    fi
else
    echo -e "${RED}请在 Mac 上运行此脚本。Windows 请用 setup.bat${NC}"
    exit 1
fi

echo -e "  系统: ${GREEN}$OS $ARCH${NC}"
echo ""

# ---- 1. Download Node.js (Current Platform) ----
download_node() {
    local platform=$1
    local dir_name=$2
    local target="$RUNTIME_DIR/$dir_name"

    if [ "$platform" = "win-x64" ]; then
        if [ -f "$target/node.exe" ]; then
            echo -e "  ${GREEN}✓${NC} Node.js ($platform) 已存在，跳过下载"
            return
        fi
        echo -e "  ${CYAN}↓${NC} 下载 Node.js $NODE_VERSION ($platform)..."
        mkdir -p "$target"
        local url="$NODE_MIRROR/$NODE_VERSION/node-$NODE_VERSION-$platform.zip"
        echo "    $url"
        local tmp_zip="/tmp/node-$platform-$$.zip"
        curl -fSL "$url" -o "$tmp_zip"
        if command -v unzip >/dev/null 2>&1; then
            unzip -q "$tmp_zip" -d "/tmp/node-extract-$$"
            cp -r "/tmp/node-extract-$$"/node-$NODE_VERSION-$platform/* "$target/"
            rm -rf "/tmp/node-extract-$$"
        else
            echo -e "    ${RED}✗ unzip not found, skipping $platform runtime${NC}"
        fi
        rm -f "$tmp_zip"
        if [ -f "$target/node.exe" ]; then
            echo -e "  ${GREEN}✓${NC} Node.js ($platform) 下载完成"
        else
            echo -e "  ${CYAN}⚠${NC}  $platform runtime 下载失败 (不影响当前平台使用)"
        fi
    else
        if [ -f "$target/bin/node" ]; then
            echo -e "  ${GREEN}✓${NC} Node.js ($platform) 已存在，跳过下载"
            return
        fi
        echo -e "  ${CYAN}↓${NC} 下载 Node.js $NODE_VERSION ($platform)..."
        mkdir -p "$target"
        local url="$NODE_MIRROR/$NODE_VERSION/node-$NODE_VERSION-$platform.tar.gz"
        echo "    $url"
        curl -fSL "$url" | tar xz -C "$target" --strip-components=1
        if [ -f "$target/bin/node" ]; then
            echo -e "  ${GREEN}✓${NC} Node.js ($platform) 下载完成"
        else
            echo -e "  ${RED}✗ Node.js ($platform) 下载失败${NC}"
            exit 1
        fi
    fi
}

# Download current platform
download_node "$PLATFORM" "$NODE_DIR_NAME"

# Download all platforms if requested
if [ "$ALL_PLATFORMS" = "true" ]; then
    if [ "$PLATFORM" != "darwin-arm64" ]; then
        download_node "darwin-arm64" "node-mac-arm64"
    fi
    if [ "$PLATFORM" != "darwin-x64" ]; then
        download_node "darwin-x64" "node-mac-x64"
    fi
    download_node "win-x64" "node-win-x64"
fi

# ---- 2. Install OpenClaw ----
NODE_TARGET="$RUNTIME_DIR/$NODE_DIR_NAME"
NODE_BIN="$NODE_TARGET/bin/node"
NPM_BIN="$NODE_TARGET/bin/npm"

if [ -d "$CORE_DIR/node_modules/openclaw" ]; then
    echo -e "  ${GREEN}✓${NC} OpenClaw 已安装，跳过"
else
    echo -e "  ${CYAN}↓${NC} 安装 OpenClaw..."
    mkdir -p "$CORE_DIR"
    "$NODE_BIN" "$NPM_BIN" install --prefix "$CORE_DIR" --registry="$MIRROR"
    echo -e "  ${GREEN}✓${NC} OpenClaw 安装完成"
fi

# ---- 3. Install QQ Plugin ----
if [ -d "$CORE_DIR/node_modules/@sliverp/qqbot" ]; then
    echo -e "  ${GREEN}✓${NC} QQ 插件已安装，跳过"
else
    echo -e "  ${CYAN}↓${NC} 安装 QQ 插件..."
    "$NODE_BIN" "$NPM_BIN" install @sliverp/qqbot@latest --prefix "$CORE_DIR" --registry="$MIRROR" 2>/dev/null || true
    echo -e "  ${GREEN}✓${NC} QQ 插件安装完成"
fi

# ---- 4. Install China-optimized skills ----
SKILLS_SRC="$SCRIPT_DIR/skills"
SKILLS_TARGET="$CORE_DIR/node_modules/openclaw/skills"

if [ -d "$SKILLS_SRC" ] && [ -d "$SKILLS_TARGET" ]; then
    echo -e "  ${CYAN}↓${NC} 安装中国优化技能..."
    SKILL_COUNT=0
    for skill_dir in "$SKILLS_SRC"/*/; do
        [ ! -d "$skill_dir" ] && continue
        skill_name=$(basename "$skill_dir")
        if [ ! -d "$SKILLS_TARGET/$skill_name" ]; then
            cp -R "$skill_dir" "$SKILLS_TARGET/$skill_name"
            SKILL_COUNT=$((SKILL_COUNT + 1))
        fi
    done
    echo -e "  ${GREEN}✓${NC} 中国技能安装完成 (+$SKILL_COUNT 个)"
fi

# ---- 5. Download toolkit (Node.js installers) ----
if [ "$WITH_TOOLKIT" = "true" ]; then
    TOOLKIT_DIR="$SCRIPT_DIR/toolkit"
    mkdir -p "$TOOLKIT_DIR"
    echo ""
    echo -e "  ${CYAN}↓${NC} 下载 Node.js 安装包到 toolkit/..."

    # Mac pkg
    MAC_PKG="node-$NODE_VERSION.pkg"
    if [ ! -f "$TOOLKIT_DIR/$MAC_PKG" ]; then
        echo -e "    下载 $MAC_PKG..."
        curl -fSL "$NODE_MIRROR/$NODE_VERSION/$MAC_PKG" -o "$TOOLKIT_DIR/$MAC_PKG"
        echo -e "  ${GREEN}✓${NC} $MAC_PKG"
    else
        echo -e "  ${GREEN}✓${NC} $MAC_PKG 已存在"
    fi

    # Windows msi
    WIN_MSI="node-$NODE_VERSION-x64.msi"
    if [ ! -f "$TOOLKIT_DIR/$WIN_MSI" ]; then
        echo -e "    下载 $WIN_MSI..."
        curl -fSL "$NODE_MIRROR/$NODE_VERSION/$WIN_MSI" -o "$TOOLKIT_DIR/$WIN_MSI"
        echo -e "  ${GREEN}✓${NC} $WIN_MSI"
    else
        echo -e "  ${GREEN}✓${NC} $WIN_MSI 已存在"
    fi
fi

# ---- Done ----
echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ 搭建完成！${NC}"
echo ""
echo -e "  启动方式:"
echo -e "    Mac:     双击 ${CYAN}启动 M-Claw.command${NC}"
echo -e "    Windows: 双击 ${CYAN}Windows-Start.bat${NC}"
echo ""
echo -e "  目录结构:"
echo -e "    core/       ← OpenClaw + 依赖"
echo -e "    runtime/    ← Node.js $NODE_VERSION"
echo -e "    data/       ← 运行后自动生成"
echo ""
if [ "$ALL_PLATFORMS" != "true" ]; then
    echo -e "  ${CYAN}提示: 制作跨平台 U 盘请用 bash setup.sh --all-platforms${NC}"
fi
if [ "$WITH_TOOLKIT" != "true" ]; then
    echo -e "  ${CYAN}提示: 下载安装包到 toolkit/ 请用 bash setup.sh --with-toolkit${NC}"
fi
echo -e "${GREEN}════════════════════════════════════════${NC}"
