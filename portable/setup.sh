#!/bin/bash
# ============================================================
# U-Claw Portable — 开发环境搭建脚本
# 用法: bash setup.sh
# 作用: 下载 Node.js 运行时 + 安装 OpenClaw 到 app/ 目录
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/app"
CORE_DIR="$APP_DIR/core"
RUNTIME_DIR="$APP_DIR/runtime"
MIRROR="https://registry.npmmirror.com"
NODE_MIRROR="https://npmmirror.com/mirrors/node"
NODE_VERSION="v22.22.3"
ALL_PLATFORMS=false
[ "$1" = "--all-platforms" ] && ALL_PLATFORMS=true

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  🦞 U-Claw Portable Setup           ║${NC}"
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
NODE_TARGET="$RUNTIME_DIR/$NODE_DIR_NAME"

if [ -f "$NODE_TARGET/bin/node" ]; then
    echo -e "  ${GREEN}✓${NC} Node.js ($PLATFORM) 已存在，跳过下载"
else
    echo -e "  ${CYAN}↓${NC} 下载 Node.js $NODE_VERSION ($PLATFORM)..."
    mkdir -p "$NODE_TARGET"

    NODE_URL="$NODE_MIRROR/$NODE_VERSION/node-$NODE_VERSION-$PLATFORM.tar.gz"
    echo "    $NODE_URL"

    curl -fSL "$NODE_URL" | tar xz -C "$NODE_TARGET" --strip-components=1

    if [ -f "$NODE_TARGET/bin/node" ]; then
        echo -e "  ${GREEN}✓${NC} Node.js ($PLATFORM) 下载完成"
    else
        echo -e "  ${RED}✗ Node.js 下载失败${NC}"
        exit 1
    fi
fi

# ---- 1b. Download Node.js for Windows (only with --all-platforms) ----
if [ "$ALL_PLATFORMS" = "true" ]; then
    WIN_NODE_TARGET="$RUNTIME_DIR/node-win-x64"
    if [ -f "$WIN_NODE_TARGET/node.exe" ]; then
        echo -e "  ${GREEN}✓${NC} Node.js (win-x64) 已存在，跳过下载"
    else
        echo -e "  ${CYAN}↓${NC} 下载 Node.js $NODE_VERSION (win-x64) - Windows支持..."
        mkdir -p "$WIN_NODE_TARGET"

        WIN_NODE_URL="$NODE_MIRROR/$NODE_VERSION/node-$NODE_VERSION-win-x64.zip"
        echo "    $WIN_NODE_URL"

        TMP_ZIP="/tmp/node-win-x64-$$.zip"
        curl -fSL "$WIN_NODE_URL" -o "$TMP_ZIP"

        if command -v unzip >/dev/null 2>&1; then
            unzip -q "$TMP_ZIP" -d "/tmp/node-win-extract-$$"
            cp -r "/tmp/node-win-extract-$$"/node-$NODE_VERSION-win-x64/* "$WIN_NODE_TARGET/"
            rm -rf "/tmp/node-win-extract-$$"
        else
            echo -e "    ${RED}✗ unzip not found, skipping Windows runtime${NC}"
        fi
        rm -f "$TMP_ZIP"

        if [ -f "$WIN_NODE_TARGET/node.exe" ]; then
            echo -e "  ${GREEN}✓${NC} Node.js (win-x64) 下载完成"
        else
            echo -e "  ${CYAN}⚠${NC}  Windows runtime下载失败 (不影响当前平台使用)"
        fi
    fi
fi

# ---- 2. Install OpenClaw ----
if [ -d "$CORE_DIR/node_modules/openclaw" ]; then
    echo -e "  ${GREEN}✓${NC} OpenClaw 已安装，跳过"
else
    echo -e "  ${CYAN}↓${NC} 安装 OpenClaw..."
    mkdir -p "$CORE_DIR"

    # Init package.json if not exists (pinned OpenClaw version from OPENCLAW_VERSION)
    OPENCLAW_VERSION_FILE="$(dirname "$0")/OPENCLAW_VERSION"
    if [ ! -f "$OPENCLAW_VERSION_FILE" ]; then
        OPENCLAW_VERSION_FILE="$(dirname "$0")/../OPENCLAW_VERSION"
    fi
    OPENCLAW_VERSION="2026.4.29"
    if [ -f "$OPENCLAW_VERSION_FILE" ]; then
        OPENCLAW_VERSION="$(tr -d '[:space:]' < "$OPENCLAW_VERSION_FILE")"
        # Copy version file into portable/ so USB users can read it without repo root
        cp "$OPENCLAW_VERSION_FILE" "$(dirname "$0")/OPENCLAW_VERSION" 2>/dev/null || true
    fi
    if [ ! -f "$CORE_DIR/package.json" ]; then
        cat > "$CORE_DIR/package.json" << PKGJSON
{
  "name": "u-claw-core",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "openclaw": "$OPENCLAW_VERSION"
  }
}
PKGJSON
    fi

    # Install with China mirror（缓存留盘内，拔盘不留痕）
    # --ignore-scripts 必须加：openclaw 的 preinstall 脚本会调系统 `node`，但便携版
    # 用的是 app/runtime 下的 node（不在 PATH），未装 Node 的 Mac 用户会因
    # "node: command not found" 安装失败 (code 127)。与 Mac-Start.command 的 fallback 对齐。
    NODE_BIN="$NODE_TARGET/bin/node"
    NPM_BIN="$NODE_TARGET/bin/npm"
    npm_config_cache="$APP_DIR/.npm-cache" "$NODE_BIN" "$NPM_BIN" install --prefix "$CORE_DIR" --registry="$MIRROR" --ignore-scripts --no-audit --no-fund --omit=dev

    echo -e "  ${GREEN}✓${NC} OpenClaw 安装完成"
fi

# ---- 3. Install QQ Plugin ----
if [ -d "$CORE_DIR/node_modules/@sliverp/qqbot" ]; then
    echo -e "  ${GREEN}✓${NC} QQ 插件已安装，跳过"
else
    echo -e "  ${CYAN}↓${NC} 安装 QQ 插件..."
    NODE_BIN="$NODE_TARGET/bin/node"
    NPM_BIN="$NODE_TARGET/bin/npm"
    npm_config_cache="$APP_DIR/.npm-cache" "$NODE_BIN" "$NPM_BIN" install @sliverp/qqbot@latest --prefix "$CORE_DIR" --registry="$MIRROR" --ignore-scripts --no-audit --no-fund --omit=dev 2>/dev/null || true
    echo -e "  ${GREEN}✓${NC} QQ 插件安装完成"
fi

# ---- 4. Install China-optimized skills ----
SKILLS_CN="$SCRIPT_DIR/skills-cn"
SKILLS_TARGET="$CORE_DIR/node_modules/openclaw/skills"

if [ -d "$SKILLS_CN" ] && [ -d "$SKILLS_TARGET" ]; then
    echo -e "  ${CYAN}↓${NC} 安装中国优化技能 (skills-cn)..."
    SKILL_COUNT=0
    for skill_dir in "$SKILLS_CN"/*/; do
        skill_name=$(basename "$skill_dir")
        if [ ! -d "$SKILLS_TARGET/$skill_name" ]; then
            cp -R "$skill_dir" "$SKILLS_TARGET/$skill_name"
            SKILL_COUNT=$((SKILL_COUNT + 1))
        fi
    done
    echo -e "  ${GREEN}✓${NC} 中国技能安装完成 (+$SKILL_COUNT 个)"
fi

# ---- Done ----
echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ 搭建完成！${NC}"
echo ""
echo -e "  启动方式:"
echo -e "    Mac:     ${CYAN}bash Mac-Start.command${NC}"
echo -e "    Windows: 双击 ${CYAN}Windows-Start.bat${NC}"
echo ""
echo -e "  目录结构:"
echo -e "    app/core/       ← OpenClaw + 依赖"
echo -e "    app/runtime/    ← Node.js $NODE_VERSION"
echo -e "    data/           ← 运行后自动生成"
echo ""
echo -e "  ${CYAN}提示: 制作跨平台 U 盘请用 bash setup.sh --all-platforms${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
