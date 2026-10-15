#!/bin/bash
# ============================================================
# U-Claw Portable — 开发环境搭建脚本
# 用法: bash setup.sh
# 作用: 下载 Node.js 运行时 + 安装 OpenClaw 到 app/ 目录
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/app"
CORE_DIR="$APP_DIR/core"
RUNTIME_DIR="$APP_DIR/runtime"
MIRROR="https://registry.npmmirror.com"
NODE_MIRROR="https://npmmirror.com/mirrors/node"
NODE_VERSION="v24.16.0"
ALL_PLATFORMS=false
[ "${1:-}" = "--all-platforms" ] && ALL_PLATFORMS=true

# Serialize first-run setup as well as upgrades, including on exFAT USB drives.
mkdir -p "$APP_DIR"
SETUP_LOCK="$APP_DIR/.setup-lock"
if ! mkdir "$SETUP_LOCK" 2>/dev/null; then
    LOCK_PID=$(cat "$SETUP_LOCK/pid" 2>/dev/null || true)
    if [[ "$LOCK_PID" =~ ^[0-9]+$ ]] && ! kill -0 "$LOCK_PID" 2>/dev/null; then
        rm -f "$SETUP_LOCK/pid"
        rmdir "$SETUP_LOCK" 2>/dev/null || true
        mkdir "$SETUP_LOCK" 2>/dev/null || { echo "另一个安装进程正在运行" >&2; exit 1; }
    else
        echo "另一个安装进程正在运行，请等待完成后再启动。" >&2
        exit 1
    fi
fi
printf '%s\n' "$$" > "$SETUP_LOCK/pid"
trap 'rm -f "$SETUP_LOCK/pid"; rmdir "$SETUP_LOCK" 2>/dev/null || true' EXIT

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
elif [ "$OS" = "Linux" ]; then
    case "$ARCH" in
        x86_64) PLATFORM="linux-x64"; NODE_DIR_NAME="node-linux-x64" ;;
        aarch64|arm64) PLATFORM="linux-arm64"; NODE_DIR_NAME="node-linux-arm64" ;;
        *) echo "Unsupported Linux architecture: $ARCH" >&2; exit 1 ;;
    esac
else
    echo -e "${RED}请在 Mac/Linux 上运行此脚本。Windows 请用 setup.bat${NC}"
    exit 1
fi

echo -e "  系统: ${GREEN}$OS $ARCH${NC}"
echo ""

# ---- 1. Download Node.js (Current Platform) ----
NODE_TARGET="$RUNTIME_DIR/$NODE_DIR_NAME"

install_mac_node() {
    local platform="$1" target="$RUNTIME_DIR/$2"
    local installed="" archive
    if [ -x "$target/bin/node" ]; then
        installed=$("$target/bin/node" --version 2>/dev/null || true)
    fi
    if [ "$installed" = "$NODE_VERSION" ]; then
        echo -e "  ${GREEN}✓${NC} Node.js ($platform) $NODE_VERSION 已存在"
        return
    fi
    echo -e "  ${CYAN}↓${NC} 下载 Node.js $NODE_VERSION ($platform)..."
    archive=$(mktemp "${TMPDIR:-/tmp}/uclaw-node.XXXXXX")
    curl -fSL --connect-timeout 20 --max-time 300 --retry 2 \
        "$NODE_MIRROR/$NODE_VERSION/node-$NODE_VERSION-$platform.tar.gz" -o "$archive" || \
        curl -fSL --connect-timeout 20 --max-time 300 --retry 2 \
        "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$platform.tar.gz" -o "$archive"
    mkdir -p "$target"
    tar xzf "$archive" -C "$target" --strip-components=1
    rm -f "$archive"
    [ -f "$target/bin/node" ] || { echo "Node.js 下载失败" >&2; exit 1; }
    # 另一种 Mac 架构不能在当前主机上执行；版本由所下载的固定归档名保证。
    echo -e "  ${GREEN}✓${NC} Node.js ($platform) 下载完成"
}
install_mac_node "$PLATFORM" "$NODE_DIR_NAME"
if [ "$ALL_PLATFORMS" = "true" ]; then
    if [ "$PLATFORM" = "darwin-arm64" ]; then
        install_mac_node "darwin-x64" "node-mac-x64"
    elif [ "$PLATFORM" = "darwin-x64" ]; then
        install_mac_node "darwin-arm64" "node-mac-arm64"
    else
        install_mac_node "darwin-arm64" "node-mac-arm64"
        install_mac_node "darwin-x64" "node-mac-x64"
    fi
fi

# ---- 1b. Download Node.js for Windows (only with --all-platforms) ----
if [ "$ALL_PLATFORMS" = "true" ]; then
    WIN_NODE_TARGET="$RUNTIME_DIR/node-win-x64"
    WIN_NODE_MARKER="$WIN_NODE_TARGET/UCLAW_NODE_VERSION"
    if [ -f "$WIN_NODE_TARGET/node.exe" ] && [ "$(cat "$WIN_NODE_MARKER" 2>/dev/null || true)" = "$NODE_VERSION" ]; then
        echo -e "  ${GREEN}✓${NC} Node.js (win-x64) 已存在，跳过下载"
    else
        echo -e "  ${CYAN}↓${NC} 下载 Node.js $NODE_VERSION (win-x64) - Windows支持..."
        mkdir -p "$WIN_NODE_TARGET"

        WIN_NODE_URL="$NODE_MIRROR/$NODE_VERSION/node-$NODE_VERSION-win-x64.zip"
        echo "    $WIN_NODE_URL"

        TMP_ZIP="/tmp/node-win-x64-$$.zip"
        curl -fSL --connect-timeout 20 --max-time 300 --retry 2 "$WIN_NODE_URL" -o "$TMP_ZIP" || \
            curl -fSL --connect-timeout 20 --max-time 300 --retry 2 \
            "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-win-x64.zip" -o "$TMP_ZIP"

        if command -v unzip >/dev/null 2>&1; then
            unzip -q "$TMP_ZIP" -d "/tmp/node-win-extract-$$"
            cp -r "/tmp/node-win-extract-$$"/node-$NODE_VERSION-win-x64/* "$WIN_NODE_TARGET/"
            rm -rf "/tmp/node-win-extract-$$"
        else
            echo -e "    ${RED}✗ unzip not found${NC}"
            exit 1
        fi
        rm -f "$TMP_ZIP"

        if [ -f "$WIN_NODE_TARGET/node.exe" ]; then
            printf '%s\n' "$NODE_VERSION" > "$WIN_NODE_MARKER"
            echo -e "  ${GREEN}✓${NC} Node.js (win-x64) 下载完成"
        else
            echo -e "  ${RED}✗${NC} Windows runtime下载失败"
            exit 1
        fi
    fi
fi

# ---- 2. Install OpenClaw ----
OPENCLAW_VERSION_FILE="$SCRIPT_DIR/OPENCLAW_VERSION"
if [ ! -f "$OPENCLAW_VERSION_FILE" ]; then
    OPENCLAW_VERSION_FILE="$SCRIPT_DIR/../OPENCLAW_VERSION"
fi
[ -f "$OPENCLAW_VERSION_FILE" ] || { echo "OPENCLAW_VERSION 缺失" >&2; exit 1; }
OPENCLAW_VERSION="$(tr -d '[:space:]' < "$OPENCLAW_VERSION_FILE")"
[[ "$OPENCLAW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "OPENCLAW_VERSION 无效" >&2; exit 1; }
NODE_BIN="$NODE_TARGET/bin/node"
NPM_BIN="$NODE_TARGET/bin/npm"
export PATH="$NODE_TARGET/bin:$PATH"
mkdir -p "$CORE_DIR"

# 更新已有安装的依赖 pin，并剔除旧版额外渠道插件；不读取或覆盖 data/。
"$NODE_BIN" --input-type=module - "$CORE_DIR" "$OPENCLAW_VERSION" <<'UPDATE_PACKAGE'
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
const file = resolve(process.argv[2], 'package.json');
const pkg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : { name: 'u-claw-core', version: '1.0.0', private: true };
pkg.dependencies = { openclaw: process.argv[3] };
delete pkg.optionalDependencies;
const temp = file + '.uclaw-tmp';
writeFileSync(temp, JSON.stringify(pkg, null, 2) + '\n');
renameSync(temp, file);
UPDATE_PACKAGE

INSTALLED_VERSION=$("$NODE_BIN" -p 'try { require(process.argv[1]).version } catch { "" }' "$CORE_DIR/node_modules/openclaw/package.json")
if [ "$INSTALLED_VERSION" = "$OPENCLAW_VERSION" ]; then
    echo -e "  ${GREEN}✓${NC} OpenClaw $OPENCLAW_VERSION 已安装，检查依赖"
else
    echo -e "  ${CYAN}↓${NC} 安装 OpenClaw $OPENCLAW_VERSION (当前: ${INSTALLED_VERSION:-未安装})..."
fi

# Install with China mirror（缓存留盘内，拔盘不留痕）
# --ignore-scripts 必须加：openclaw 的 preinstall 脚本会调系统 `node`，但便携版
# 用的是 app/runtime 下的 node（不在 PATH），未装 Node 的 Mac 用户会因
# "node: command not found" 安装失败 (code 127)。与 Mac-Start.command 的 fallback 对齐。
npm_config_fetch_retries=2 npm_config_fetch_timeout=60000 npm_config_cache="$APP_DIR/.npm-cache" \
    "$NODE_BIN" "$NPM_BIN" install --prefix "$CORE_DIR" --registry="$MIRROR" --ignore-scripts --no-audit --no-fund --omit=dev
ACTUAL_VERSION=$("$NODE_BIN" -p 'require(process.argv[1]).version' "$CORE_DIR/node_modules/openclaw/package.json")
[ "$ACTUAL_VERSION" = "$OPENCLAW_VERSION" ] || { echo "OpenClaw 版本校验失败: $ACTUAL_VERSION" >&2; exit 1; }

# Keep durable OpenClaw state on the USB volume, but redirect only the
# managed Chromium profile to the host cache.  These vendor patches are
# intentionally fail-closed: a changed upstream bundle must be reviewed
# instead of silently producing a partially portable installation.
"$NODE_BIN" "$SCRIPT_DIR/lib/patch-managed-browser-root.mjs" "$CORE_DIR"
"$NODE_BIN" "$SCRIPT_DIR/lib/patch-device-pairing-retry.mjs" "$CORE_DIR"
"$NODE_BIN" "$SCRIPT_DIR/lib/patch-control-ui-channels.mjs" "$CORE_DIR"
"$NODE_BIN" "$SCRIPT_DIR/lib/patch-portable-filesystem.mjs" "$CORE_DIR"
"$NODE_BIN" --check "$CORE_DIR/node_modules/openclaw/dist/chrome-D7PwFEoa.mjs"
"$NODE_BIN" --check "$CORE_DIR/node_modules/@openclaw/fs-safe/dist/replace-file.js"
"$NODE_BIN" --check "$CORE_DIR/node_modules/openclaw/dist/openclaw-cli-shim-I4WwJOH3.mjs"
"$NODE_BIN" --check "$CORE_DIR/node_modules/openclaw/dist/diagnostic-stability-bundle-vmtXgIWw.mjs"
"$NODE_BIN" --input-type=module - "$CORE_DIR/.uclaw-runtime-platform" <<'WRITE_PLATFORM'
import { writeFileSync, renameSync } from 'node:fs';
const target = process.argv[2];
writeFileSync(target + '.uclaw-tmp', process.platform + '-' + process.arch + '\n');
renameSync(target + '.uclaw-tmp', target);
WRITE_PLATFORM

echo -e "  ${GREEN}✓${NC} OpenClaw 安装完成"

# ---- 3. Install China-optimized skills ----
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
